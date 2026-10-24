//! A TCP proxy for fault injection: put it between a client and the disposable server, then drop,
//! stall or refuse connections on command.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Default)]
struct Shared {
    /// Bytes are read but not passed on (a network that went silent).
    stalled: AtomicBool,
    /// Pump tasks of live connections, to cut them.
    pumps: Mutex<Vec<JoinHandle<()>>>,
}

pub struct FaultProxy {
    port: u16,
    upstream: SocketAddr,
    shared: Arc<Shared>,
    accept: Mutex<Option<JoinHandle<()>>>,
}

async fn pump(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    shared: Arc<Shared>,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if shared.stalled.load(Ordering::SeqCst) {
            continue;
        }
        if to.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    let _ = to.shutdown().await;
}

fn serve(listener: TcpListener, upstream: SocketAddr, shared: Arc<Shared>) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let Ok(server) = TcpStream::connect(upstream).await else {
                continue;
            };
            let (client_read, client_write) = client.into_split();
            let (server_read, server_write) = server.into_split();
            let up = tokio::spawn(pump(client_read, server_write, Arc::clone(&shared)));
            let down = tokio::spawn(pump(server_read, client_write, Arc::clone(&shared)));
            let mut pumps = shared.pumps.lock().unwrap_or_else(|p| p.into_inner());
            pumps.retain(|t| !t.is_finished());
            pumps.push(up);
            pumps.push(down);
        }
    })
}

impl FaultProxy {
    pub async fn start(upstream: SocketAddr) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind proxy");
        let port = listener.local_addr().expect("addr").port();
        let shared = Arc::new(Shared::default());
        let accept = serve(listener, upstream, Arc::clone(&shared));
        Self {
            port,
            upstream,
            shared,
            accept: Mutex::new(Some(accept)),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Cuts every open connection (both directions close), like a dropped network or a server
    /// that went away.
    pub fn drop_connections(&self) {
        let pumps: Vec<_> = self
            .shared
            .pumps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain(..)
            .collect();
        for pump in pumps {
            pump.abort();
        }
    }

    /// While stalled, nothing gets through in either direction, but connections stay open.
    pub fn stall(&self, stalled: bool) {
        self.shared.stalled.store(stalled, Ordering::SeqCst);
    }

    /// Stops listening: new connections are refused, as when the server is down.
    pub fn refuse(&self) {
        if let Some(accept) = self.accept.lock().unwrap_or_else(|p| p.into_inner()).take() {
            accept.abort();
        }
    }

    /// Listens again on the same port, as when the server is back.
    pub async fn resume(&self) {
        if self
            .accept
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
        {
            return;
        }
        let mut tries = 0;
        let listener = loop {
            match TcpListener::bind(("127.0.0.1", self.port)).await {
                Ok(l) => break l,
                Err(_) if tries < 50 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(e) => panic!("rebind proxy port {}: {e}", self.port),
            }
        };
        *self.accept.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(serve(listener, self.upstream, Arc::clone(&self.shared)));
    }
}

impl Drop for FaultProxy {
    fn drop(&mut self) {
        self.refuse();
        self.drop_connections();
    }
}
