// Test-only stand-in for the Rust backend, injected before the app loads (page.addInitScript).
// It installs window.__TAURI_INTERNALS__ the way @tauri-apps/api/mocks does, so the app takes its
// real Tauri code path (ipc/client.ts `tauriBackend`): command names, argument shapes, Channels and
// events are all exercised. Every call is recorded in window.__fakeIpc.calls; a command this fake
// does not know is recorded in window.__fakeIpc.unhandled and rejected, so tests can assert on it.
(() => {
  const callbacks = new Map();
  let nextCallback = 1;
  const listeners = new Map(); // event name -> handler ids

  const state = {
    calls: [],
    unhandled: [],
    settings: {
      theme: 'light',
      editorFontSize: 13,
      resultTabs: 'reuse',
      statementTimeoutSecs: 0,
      longQuerySecs: 20,
      runOutsideStatement: 'nearest',
      runSelection: 'all',
      historyLimit: 10000,
      historyMaxAgeDays: 0,
      revisionLimit: 100,
      revisionMaxAgeDays: 30,
      revisionIntervalMins: 5,
      keymap: {},
    },
    workspace: null,
    connections: [],
    folders: [],
    consoles: new Map(),
    seq: 0,
    // Per session (sourceId + console): transaction settings and status.
    sessions: new Map(),
    // Query history, newest first, recorded by query_execute as the Rust job does.
    history: [],
    // AI: like the Rust side, only whether a key is stored is known, never the key.
    ai: { enabled: false, model: 'claude-sonnet-5-5', disabledWorkspaces: [], ignore: [] },
    aiKeyStored: false,
  };

  const aiStatus = () => ({
    settings: structuredClone(state.ai),
    keyStored: state.aiKeyStored,
    workspaceId: 'main',
    active: state.ai.enabled && !state.ai.disabledWorkspaces.includes('main'),
  });

  const sessionKey = (session) => `${session.sourceId}|${session.console ?? ''}`;
  function sessionState(session) {
    const s = state.sessions.get(sessionKey(session)) ?? {
      settings: { mode: 'auto', isolation: 'read_committed' },
      status: 'idle',
    };
    return { session, open: true, status: s.status, settings: s.settings };
  }
  function updateSession(session, patch) {
    const next = { ...sessionState(session), ...patch };
    state.sessions.set(sessionKey(session), { settings: next.settings, status: next.status });
    setTimeout(() => emit('session-state', sessionState(session)), 0);
    return sessionState(session);
  }

  const INFO = {
    version: 'PostgreSQL 16.15 (fake)',
    serverVersion: '16.15',
    database: 'app',
    user: 'dev',
    tls: true,
    readOnly: false,
    latencyMs: 3,
  };

  const ROWS = {
    type: 'rows',
    columns: [
      { name: 'id', typeName: 'int4' },
      { name: 'email', typeName: 'text' },
    ],
    rows: [
      ['1', 'a@example.test'],
      ['2', null],
    ],
    totalRows: 2,
    truncated: false,
    cursor: 'quarry_c1',
    edit: { status: 'readOnly', reason: 'Fake backend' },
  };

  function reject(kind, message) {
    return Promise.reject({ kind, message });
  }

  function run(id, data) {
    const cb = callbacks.get(id);
    if (cb) {
      cb(data);
    }
  }

  /** Sends messages on a Channel the way Rust does: indexed, then an end marker. */
  function sendOnChannel(channel, messages) {
    setTimeout(() => {
      messages.forEach((message, index) => run(channel.id, { index, message }));
      run(channel.id, { index: messages.length, end: true });
    }, 0);
  }

  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
      run(handler, { event, id: handler, payload });
    }
  }

  function catalog(request) {
    switch (request.level) {
      case 'schemas':
        return [
          {
            key: 's:shop',
            kind: 'schema',
            name: 'shop',
            children: { level: 'schemaGroups', schema: 'shop' },
          },
        ];
      case 'schemaGroups':
        return [
          {
            key: 'g:tables',
            kind: 'group',
            name: 'Tables',
            count: 2,
            children: { level: 'objects', schema: request.schema, types: ['table'] },
          },
        ];
      case 'objects':
        return ['customers', 'orders'].map((name) => ({
          key: `o:${name}`,
          kind: 'table',
          name,
          children: {
            level: 'objectGroups',
            schema: request.schema,
            name,
            objectType: 'table',
          },
        }));
      case 'objectGroups':
        return [
          {
            key: 'g:columns',
            kind: 'group',
            name: 'Columns',
            count: 2,
            children: { level: 'columns', schema: request.schema, table: request.name },
          },
        ];
      case 'columns':
        return [
          { key: 'c:id', kind: 'column', name: 'id', detail: 'int4', flags: ['pk', 'not null'] },
          { key: 'c:email', kind: 'column', name: 'email', detail: 'text' },
        ];
      case 'catalog':
        return ['customers', 'orders'].map((name) => ({
          key: `shop\u001fo:${name}`,
          kind: 'table',
          name,
          detail: 'shop',
        }));
      default:
        return [];
    }
  }

  const commands = {
    settings_get: () => state.settings,
    settings_set: ({ settings }) => (state.settings = settings),
    workspace_get: () => state.workspace,
    workspace_set: ({ state: next }) => {
      state.workspace = next;
      return null;
    },
    connections_list: () => [...state.connections],
    connection_create: ({ draft, password }) => {
      if (state.connections.some((c) => c.name === draft.name.trim())) {
        return reject('invalid', `A data source named "${draft.name}" already exists.`);
      }
      state.seq += 1;
      const now = new Date().toISOString();
      const profile = {
        ...draft,
        name: draft.name.trim(),
        id: `fake-${state.seq}`,
        passwordSaved: password !== null,
        sortOrder: state.connections.filter((c) => c.folderId === draft.folderId).length,
        createdAt: now,
        updatedAt: now,
      };
      state.connections.push(profile);
      return profile;
    },
    connection_rename: ({ id, name }) => {
      const c = state.connections.find((x) => x.id === id);
      c.name = name.trim();
      return c;
    },
    connection_move: ({ id, folderId, index }) => {
      const moved = state.connections.find((c) => c.id === id);
      const siblings = state.connections
        .filter((c) => c.folderId === folderId && c.id !== id)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      siblings.splice(Math.min(index, siblings.length), 0, moved);
      siblings.forEach((c, i) => {
        c.folderId = folderId;
        c.sortOrder = i;
      });
      state.connections.sort(
        (a, b) =>
          Number(a.folderId !== null) - Number(b.folderId !== null) ||
          (a.folderId ?? '').localeCompare(b.folderId ?? '') ||
          a.sortOrder - b.sortOrder,
      );
      return null;
    },
    folders_list: () => [...state.folders],
    folder_create: ({ name, color }) => {
      state.seq += 1;
      const folder = { id: `folder-${state.seq}`, name, color, sortOrder: state.folders.length };
      state.folders.push(folder);
      return folder;
    },
    folder_update: ({ folderId, name, color }) => {
      const folder = state.folders.find((f) => f.id === folderId);
      Object.assign(folder, { name, color });
      return folder;
    },
    ssh_profiles_list: () => [],
    connection_test: () => INFO,
    connection_connect: ({ id }) => {
      setTimeout(() => emit('connection-status', { state: 'connected', id, info: INFO }), 0);
      return INFO;
    },
    connection_disconnect: ({ id }) => {
      setTimeout(() => emit('connection-status', { state: 'disconnected', id }), 0);
      return null;
    },
    sessions_list: () => [],
    metadata_children: ({ request }) => catalog(request),
    object_details: ({ object }) => ({
      object,
      comment: 'Fake table for UI tests',
      columns: [
        {
          name: 'id',
          typeName: 'integer',
          nullable: false,
          default: null,
          primaryKey: true,
          identity: 'always',
          generated: null,
          comment: null,
        },
        {
          name: 'email',
          typeName: 'text',
          nullable: true,
          default: null,
          primaryKey: false,
          identity: null,
          generated: null,
          comment: 'Login name',
        },
      ],
      indexes: [
        { name: `${object.name}_pkey`, definition: 'btree (id)', unique: true, primary: true },
      ],
      constraints: [
        { name: `${object.name}_pkey`, kind: 'primary key', definition: 'PRIMARY KEY (id)' },
      ],
      references: [],
      referencedBy: [],
      triggers: [],
      rowEstimate: 2,
      totalBytes: 16384,
    }),
    console_list: () => [...state.consoles.keys()].sort(),
    console_create: ({ preferred }) => {
      let name = preferred && !state.consoles.has(preferred) ? preferred : 'console';
      for (let i = 1; state.consoles.has(name); i++) {
        name = `console_${i}`;
      }
      state.consoles.set(name, '');
      return name;
    },
    console_read: ({ name }) => state.consoles.get(name) ?? '',
    console_write: ({ name, text }) => {
      state.consoles.set(name, text);
      return null;
    },
    console_rename: ({ name, newName }) => {
      const text = state.consoles.get(name) ?? '';
      state.consoles.delete(name);
      state.consoles.set(newName, text);
      return null;
    },
    console_duplicate: ({ name }) => {
      let copy = `${name} copy`;
      for (let n = 2; state.consoles.has(copy); n++) {
        copy = `${name} copy ${n}`;
      }
      state.consoles.set(copy, state.consoles.get(name) ?? '');
      return copy;
    },
    console_delete: ({ name }) => {
      state.consoles.delete(name);
      return null;
    },
    consoles_dir: () => '/fake/consoles',
    console_checkpoint: () => null,
    snippets_list: () => [],
    ai_settings_get: () => aiStatus(),
    ai_settings_set: ({ settings }) => {
      state.ai = structuredClone(settings);
      return aiStatus();
    },
    ai_key_set: () => {
      state.aiKeyStored = true;
      return aiStatus();
    },
    ai_key_clear: () => {
      state.aiKeyStored = false;
      return aiStatus();
    },
    ai_models: () => ({
      models: [
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
      ],
      live: false,
    }),
    ai_test: ({ onEvent }) => {
      if (!aiStatus().active) {
        return reject('ai_disabled', 'AI features are turned off');
      }
      sendOnChannel(onEvent, [
        { type: 'started', model: state.ai.model },
        { type: 'text', text: 'O' },
        { type: 'text', text: 'K' },
        {
          type: 'done',
          stopReason: 'end_turn',
          usage: {
            inputTokens: 20,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      ]);
      return 'ai-1';
    },
    ai_cancel: () => null,
    revisions_list: () => [],
    import_pick: () => ({
      id: 'file-1',
      name: 'people.csv',
      size: 2048,
      detected: {
        encoding: 'UTF-8',
        format: {
          kind: 'delimited',
          encoding: null,
          delimiter: ',',
          quote: '"',
          escape: null,
          header: true,
          trim: false,
          nullToken: null,
          emptyIsNull: true,
        },
      },
    }),
    import_preview: () => ({
      columns: ['id', 'name'],
      inferred: ['integer', 'text'],
      rows: [
        ['1', 'Ann'],
        ['2', null],
      ],
      lines: [2, 3],
      estimatedRows: 2,
    }),
    import_run: ({ onEvent }) => {
      sendOnChannel(onEvent, [
        { event: 'progress', rows: 2, rejected: 0, bytes: 2048, totalBytes: 2048 },
        {
          event: 'done',
          rows: 2,
          rejected: [],
          rejectedCount: 0,
          nulled: 0,
          elapsedMs: 5,
          cancelled: false,
        },
      ]);
      return 'import-1';
    },
    query_execute: ({ request, onEvent }) => {
      // Manual mode: the first statement opens a transaction (like the Rust session does).
      const current = sessionState(request.session);
      const ends = request.statements.some((s) => /^\s*(commit|rollback|end)\b/i.test(s.sql));
      if (current.settings.mode === 'manual' && current.status === 'idle' && !ends) {
        updateSession(request.session, { status: 'active' });
      }
      const messages = [];
      request.statements.forEach((statement, index) => {
        const outcome = /^\s*select/i.test(statement.sql)
          ? ROWS
          : { type: 'command', rowsAffected: 1 };
        messages.push({ event: 'statementStarted', index, offset: statement.offset });
        const notice = /raise notice '([^']*)'/i.exec(statement.sql);
        if (notice) {
          messages.push({
            event: 'notice',
            index,
            notice: {
              severity: 'NOTICE',
              message: notice[1],
              detail: null,
              hint: null,
              sqlstate: '00000',
            },
          });
        }
        messages.push({
          event: 'statementDone',
          index,
          offset: statement.offset,
          elapsedMs: 2,
          outcome,
        });
        state.seq += 1;
        state.history.unshift({
          id: state.seq,
          connectionId: request.session.sourceId,
          console: request.session.console ?? null,
          sql: statement.sql,
          startedAt: Date.now(),
          durationMs: 2,
          status: 'ok',
          rowCount: outcome.type === 'rows' ? outcome.totalRows : outcome.rowsAffected,
          error: null,
          txMode: current.settings.mode,
        });
      });
      messages.push({
        event: 'finished',
        status: 'completed',
        executed: request.statements.length,
        elapsedMs: 3,
      });
      sendOnChannel(onEvent, messages);
      return 'job-1';
    },
    query_cancel: () => null,
    history_search: ({ query }) =>
      state.history
        .filter((e) => !query.connectionId || e.connectionId === query.connectionId)
        .filter((e) =>
          query.text
            .toLowerCase()
            .split(/\s+/)
            .every((word) => e.sql.toLowerCase().includes(word)),
        )
        .slice(query.offset, query.offset + query.limit),
    history_delete: ({ ids }) => {
      const before = state.history.length;
      state.history = state.history.filter((e) => !ids.includes(e.id));
      return before - state.history.length;
    },
    history_clear: ({ connectionId }) => {
      const before = state.history.length;
      state.history = state.history.filter((e) => e.connectionId !== connectionId);
      return before - state.history.length;
    },
    history_export: () => '/tmp/quarry-history.csv',
    result_page: ({ offset, limit }) => ROWS.rows.slice(offset, offset + limit),
    result_close: () => null,
    result_export: ({ onProgress }) => {
      sendOnChannel(onProgress, [ROWS.rows.length]);
      return { path: '/tmp/quarry-e2e.csv', rows: ROWS.rows.length, bytes: 42 };
    },
    result_copy: ({ onProgress }) => {
      sendOnChannel(onProgress, [ROWS.rows.length]);
      return { rows: ROWS.rows.length, bytes: 42 };
    },
    result_export_cancel: () => null,
    result_format: ({ rows }) => rows.map((r) => r.map((v) => v ?? '').join('\t')).join('\n'),
    ddl_generate: ({ objects, options }) =>
      objects
        .map((o) =>
          o.kind === 'relation'
            ? `CREATE TABLE ${options.qualify ? `${o.schema}.` : ''}${o.name} (\n    id integer NOT NULL\n);\n`
            : `-- ${o.kind}\n`,
        )
        .join('\n'),
    ddl_save: () => '/tmp/quarry-e2e.sql',
    table_model: () => null,
    schema_preview: ({ change }) =>
      change.kind === 'createTable'
        ? [`CREATE TABLE ${change.table.schema}.${change.table.name || '?'} (...)`]
        : [`-- ${change.kind}`],
    schema_apply: () => null,
    session_state: ({ session }) => sessionState(session),
    session_set_tx: ({ session, settings }) => updateSession(session, { settings }),
    tx_commit: ({ session }) => updateSession(session, { status: 'idle' }),
    tx_rollback: ({ session }) => updateSession(session, { status: 'idle' }),
    session_close: () => null,
    session_drop: () => null,
    app_quit: () => null,
    'plugin:event|listen': ({ event, handler }) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return handler;
    },
    'plugin:event|unlisten': ({ event, eventId }) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((h) => h !== eventId),
      );
      return null;
    },
  };

  window.__TAURI_INTERNALS__ = {
    async invoke(cmd, args = {}) {
      state.calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });
      const handler = commands[cmd];
      if (!handler) {
        state.unhandled.push(cmd);
        return reject('unsupported', `fake IPC has no handler for ${cmd}`);
      }
      return handler(args);
    },
    transformCallback(callback, once = false) {
      const id = nextCallback++;
      callbacks.set(id, (data) => {
        if (once) {
          callbacks.delete(id);
        }
        callback?.(data);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    runCallback: run,
    callbacks,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event, id) {
      callbacks.delete(id);
    },
  };
  window.__fakeIpc = state;
})();
