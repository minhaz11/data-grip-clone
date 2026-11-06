import type { SnippetDraft } from '../../ipc/types';

/** Snippets every user has; a user snippet with the same abbreviation replaces one. */
export const BUILTIN_SNIPPETS: SnippetDraft[] = [
  {
    abbreviation: 'sel',
    description: 'SELECT ... FROM ... WHERE',
    body: 'SELECT ${1:*}\nFROM ${2:table_name}\nWHERE ${3:true};$0',
    dialect: 'any',
  },
  {
    abbreviation: 'selc',
    description: 'SELECT count(*)',
    body: 'SELECT count(*) FROM ${1:table_name}${2: WHERE ${3:true}};$0',
    dialect: 'any',
  },
  {
    abbreviation: 'ins',
    description: 'INSERT INTO ... VALUES',
    body: 'INSERT INTO ${1:table_name} (${2:column})\nVALUES (${3:value});$0',
    dialect: 'any',
  },
  {
    abbreviation: 'upd',
    description: 'UPDATE ... SET ... WHERE',
    body: 'UPDATE ${1:table_name}\nSET ${2:column} = ${3:value}\nWHERE ${4:id = 1};$0',
    dialect: 'any',
  },
  {
    abbreviation: 'del',
    description: 'DELETE FROM ... WHERE',
    body: 'DELETE FROM ${1:table_name}\nWHERE ${2:id = 1};$0',
    dialect: 'any',
  },
  {
    abbreviation: 'ct',
    description: 'CREATE TABLE',
    body: 'CREATE TABLE ${1:table_name} (\n    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n    ${2:name} ${3:text} NOT NULL$0\n);',
    dialect: 'postgresql',
  },
  {
    abbreviation: 'cte',
    description: 'WITH ... SELECT',
    body: 'WITH ${1:cte_name} AS (\n    ${2:SELECT 1}\n)\nSELECT * FROM ${1:cte_name};$0',
    dialect: 'any',
  },
  {
    abbreviation: 'exp',
    description: 'EXPLAIN (ANALYZE, BUFFERS)',
    body: 'EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};$0',
    dialect: 'postgresql',
  },
  {
    abbreviation: 'idx',
    description: 'CREATE INDEX CONCURRENTLY',
    body: 'CREATE INDEX CONCURRENTLY ${1:index_name} ON ${2:table_name} (${3:column});$0',
    dialect: 'postgresql',
  },
  {
    abbreviation: 'fn',
    description: 'CREATE FUNCTION (PL/pgSQL)',
    body: 'CREATE OR REPLACE FUNCTION ${1:name}(${2:arg integer})\nRETURNS ${3:integer}\nLANGUAGE plpgsql AS \\$\\$\nBEGIN\n    RETURN \\$1;$0\nEND;\n\\$\\$;',
    dialect: 'postgresql',
  },
  {
    abbreviation: 'do',
    description: 'DO block',
    body: "DO \\$\\$\nBEGIN\n    ${1:RAISE NOTICE 'hello';}$0\nEND\n\\$\\$;",
    dialect: 'postgresql',
  },
  {
    abbreviation: 'tx',
    description: 'BEGIN ... COMMIT',
    body: 'BEGIN;\n${1:-- statements}$0\nCOMMIT;',
    dialect: 'any',
  },
];
