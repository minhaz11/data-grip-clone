//! Encoding detection and streaming transcoding to UTF-8.

use std::io::{self, BufReader, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use encoding_rs::Encoding;
use encoding_rs_io::{DecodeReaderBytes, DecodeReaderBytesBuilder};

use super::ImportError;

/// The encoding of a file start: a byte order mark wins; otherwise valid UTF-8 is UTF-8, and
/// anything else is guessed (Latin-1 style files come out as windows-1252).
pub fn detect(head: &[u8]) -> &'static Encoding {
    if let Some((enc, _)) = Encoding::for_bom(head) {
        return enc;
    }
    // A cut multi-byte sequence at the end of the sample does not make a file non-UTF-8.
    let valid = match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 4 > head.len(),
    };
    if valid {
        return encoding_rs::UTF_8;
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(head, false);
    detector.guess(None, chardetng::Utf8Detection::Allow)
}

/// A file read as UTF-8 text, transcoded on the fly.
pub type Decoded<R> = BufReader<DecodeReaderBytes<Peeked<R>, Vec<u8>>>;

/// UTF-8 text from `file`: the BOM is removed and other encodings are transcoded as the file is
/// read. `label` fixes the encoding; `None` detects it.
pub fn decoder<R: Read>(file: R, label: Option<&str>) -> Result<Decoded<R>, ImportError> {
    let mut peeked = Peeked::new(file)?;
    let enc = match label {
        Some(label) => Encoding::for_label(label.trim().as_bytes())
            .ok_or_else(|| ImportError::Encoding(label.to_owned()))?,
        None => detect(peeked.head()),
    };
    peeked.rewind();
    let reader = DecodeReaderBytesBuilder::new()
        .encoding(Some(enc))
        // A BOM still decides (and is stripped), as browsers do.
        .bom_override(true)
        .build(peeked);
    Ok(BufReader::with_capacity(64 * 1024, reader))
}

/// A reader whose first bytes can be looked at before reading starts.
pub struct Peeked<R> {
    head: Vec<u8>,
    at: usize,
    inner: R,
}

impl<R: Read> Peeked<R> {
    fn new(mut inner: R) -> io::Result<Self> {
        let mut head = vec![0; 64 * 1024];
        let mut filled = 0;
        while filled < head.len() {
            match inner.read(&mut head[filled..])? {
                0 => break,
                n => filled += n,
            }
        }
        head.truncate(filled);
        Ok(Self {
            at: head.len(),
            head,
            inner,
        })
    }

    fn head(&self) -> &[u8] {
        &self.head
    }

    fn rewind(&mut self) {
        self.at = 0;
    }
}

impl<R: Read> Read for Peeked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.at < self.head.len() {
            let n = buf.len().min(self.head.len() - self.at);
            buf[..n].copy_from_slice(&self.head[self.at..self.at + n]);
            self.at += n;
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

/// Counts bytes read from the file, for progress.
pub struct Counting<R> {
    inner: R,
    counter: Option<Arc<AtomicU64>>,
}

impl<R> Counting<R> {
    pub fn new(inner: R, counter: Option<Arc<AtomicU64>>) -> Self {
        Self { inner, counter }
    }
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if let Some(c) = &self.counter {
            c.fetch_add(n as u64, Ordering::Relaxed);
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(bytes: &[u8], label: Option<&str>) -> String {
        let mut out = String::new();
        decoder(bytes, label)
            .expect("decoder")
            .read_to_string(&mut out)
            .expect("read");
        out
    }

    #[test]
    fn utf8_with_and_without_bom() {
        assert_eq!(decode("\u{feff}a,ü\n".as_bytes(), None), "a,ü\n");
        assert_eq!(decode("a,ü\n".as_bytes(), None), "a,ü\n");
    }

    #[test]
    fn latin1_is_detected_and_transcoded() {
        // "café,Müller" in ISO-8859-1.
        let latin1 = b"caf\xe9,M\xfcller\nna\xefve,Stra\xdfe\n";
        assert_eq!(decode(latin1, None), "café,Müller\nnaïve,Straße\n");
        assert_eq!(detect(latin1).name(), "windows-1252");
    }

    #[test]
    fn explicit_labels_win_and_unknown_ones_fail() {
        assert_eq!(decode(b"caf\xe9", Some("latin1")), "café");
        let utf16: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain("hi".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode(&utf16, None), "hi");
        assert!(matches!(
            decoder(&b"x"[..], Some("klingon")),
            Err(ImportError::Encoding(_))
        ));
    }
}
