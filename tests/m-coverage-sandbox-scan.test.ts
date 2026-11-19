// Track M (plan §19): the branches of the sandbox scan that its other tests do not reach: the odd
// corners of the YAML and .env readers, IPv6 URLs, Prisma stores, a WAR with no Spring Boot, Gradle
// modules, Python layouts, a Node port written in code, caps on files, secret keys and hosts, and the
// ways a call site is found for a host. Projects are temp dirs; the file list is passed in, so none is
// a git repo.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configEntryAt, scanSandbox } from '../lib/sandbox-scan';
import type { SandboxScan } from '../lib/sandbox-types';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Writes the files and scans them; `ghosts` are listed but not on disk. */
function scan(files: Record<string, string>, ghosts: string[] = [], budgetMs?: number): SandboxScan {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6scan-')));
  tmpDirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return scanSandbox(root, { files: [...Object.keys(files), ...ghosts], ...(budgetMs !== undefined ? { budgetMs } : {}) });
}
const asked = (s: SandboxScan, part: string): boolean => s.questions.some((q) => q.includes(part));

const NODE = { 'package.json': JSON.stringify({ name: 'a', scripts: { start: 'node server.js' }, dependencies: { express: '4' } }) };

describe('config readers: YAML corners, .env and JSON that do not parse', () => {
  test('a YAML file with odd corners, a .env with a bad line and an unclosed quote, and a broken JSON config each raise a question and none throws', () => {
    const s = scan({
      ...NODE,
      'config.yml': [
        'a: "say \\"hi\\" there"',
        "b: 'it''s fine'",
        'note: |',
        '  text under a block',
        '  more text',
        'hosts: [one.example.com, "two.example.com", ]',
        'plain: value',
        '  nested: under a scalar',
        'scalar: value',
        '  - a list under a scalar',
        'list:',
        '  -',
        '  - item',
        '  - 3',
        'just text',
        '---',
        'second: doc',
      ].join('\n'),
      '.env': ['BAD LINE WITH NO EQUALS', 'GOOD=1', 'QUOTED="never closed'].join('\n'),
      'config/default.json': '{ not json',
    });
    expect(asked(s, 'config.yml: ')).toBe(true);
    expect(asked(s, '.env: ')).toBe(true);
    expect(asked(s, 'config/default.json')).toBe(true);
  });

  test('configEntryAt reads a line of a YAML file', () => {
    expect(configEntryAt('x.yml', 'a:\n  b: v\n', 2)).toEqual({ key: 'a.b', value: 'v' });
  });
});

describe('IPv6 URLs and string literals in code', () => {
  test('a bracketed host keeps its port; an unclosed bracket is no URL; a host:port literal is a host', () => {
    const s = scan({
      ...NODE,
      'server.js': ['const a = fetch("http://[2001:db8::1]:9000/x");', 'const b = fetch("http://[2001:db8::2/");', 'const c = "10.20.30.41:8080";'].join('\n'),
    });
    const hosts = s.outbound.map((o) => [o.host, o.port]);
    expect(hosts).toContainEqual(['2001:db8::1', 9000]);
    expect(hosts).toContainEqual(['10.20.30.41', 8080]);
  });
});

describe('Node: the port, Prisma stores', () => {
  test('a port written in code is found when no script or .env gives one', () => {
    const s = scan({ 'package.json': JSON.stringify({ name: 'a', dependencies: { express: '4' } }), 'server.js': 'const app = require("express")();\napp.listen(4123);\n' });
    expect(s.app.port).toBe(4123);
  });

  test('schema.prisma providers become stores; a commented provider is read at line 1', () => {
    const s = scan({
      ...NODE,
      'db/a/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("U")\n}\n',
      'db/b/schema.prisma': 'datasource db {\n  provider = "mysql"\n}\n',
      'db/c/schema.prisma': '// provider = "mongodb"\n',
    });
    const kinds = s.stores.map((x) => x.kind).sort();
    expect(kinds).toEqual(['mongo', 'mysql', 'postgres']);
    expect(s.stores.find((x) => x.kind === 'mongo')!.where.line).toBe(1);
  });
});

describe('JVM: a WAR with no Spring Boot, a module with settings.gradle above it', () => {
  test('both are read', () => {
    const war = scan({ 'build.gradle': "plugins { id 'war' }\ndependencies { implementation 'javax.servlet:servlet-api:2.5' }\n" });
    expect(asked(war, 'the app builds a WAR with no Spring Boot plugin')).toBe(true);
    const mod = scan({
      'settings.gradle': "include 'app'\n",
      'gradlew': '#!/bin/sh\n',
      'app/build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n",
    });
    expect(mod.build.buildCommand.join(' ')).toContain(':app:');
  });
});

describe('Python layouts', () => {
  test('requirements in a requirements/ dir; FastAPI under src/', () => {
    const s = scan({
      'requirements/base.txt': 'fastapi\nuvicorn\n',
      'src/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    expect(s.stack).toBe('python');
    expect(s.build.startCommand.join(' ')).toContain('--app-dir src');
    expect(s.build.startCommand.join(' ')).toContain('app.main:app');
  });

  test('Django with and without manage.py, Flask, no framework, alembic.ini is a config file', () => {
    const withManage = scan({ 'requirements.txt': 'django\n', 'manage.py': '# django\n' });
    expect(withManage.build.startCommand).toContain('manage.py');
    const without = scan({ 'requirements.txt': 'django\n' });
    expect(asked(without, 'Django without a manage.py')).toBe(true);
    expect(asked(scan({ 'requirements.txt': 'flask\n' }), 'Flask app')).toBe(true);
    expect(asked(scan({ 'requirements.txt': 'requests\n', 'alembic.ini': '[alembic]\nsqlalchemy.url = postgresql://u@db.example.com/x\n' }), 'no web framework found')).toBe(true);
  });
});

describe('caps and the time budget', () => {
  test('more files than the cap, a config file that cannot be read, a spent time budget', () => {
    const many = Array.from({ length: 50_001 }, (_, i) => `gen/f${i}.txt`);
    const capped = scanSandbox(realpathSync(tmpdir()), { files: ['package.json', ...many] });
    expect(capped.questions.some((q) => q.includes('only the first 50000 were scanned'))).toBe(true);
    const ghost = scan(NODE, ['config/production.yml', 'gone.js']);
    expect(asked(ghost, 'could not be read')).toBe(true);
    expect(asked(ghost, 'source file(s) were not read')).toBe(true);
    const late = scan({ ...NODE, 'server.js': 'fetch("http://a.example.com/x")' }, [], -1);
    expect(late.outbound).toEqual([]);
  });

  test('more secret-looking keys than the cap, more hosts than the cap', () => {
    const env = Array.from({ length: 305 }, (_, i) => `SECRET_KEY_${i}=v${i}`).join('\n');
    const urls = Array.from({ length: 305 }, (_, i) => `fetch("https://h${i}.example.com/p");`).join('\n');
    const s = scan({ ...NODE, '.env': env, 'server.js': urls });
    expect(s.secretKeys).toHaveLength(300);
    expect(asked(s, 'secret-looking keys; only the first 300')).toBe(true);
    expect(s.outbound).toHaveLength(300);
    expect(asked(s, 'outbound hosts; only the first 300')).toBe(true);
  });
});

describe('call sites of a host', () => {
  const BUILD = "plugins { id 'org.springframework.boot' version '3.2.0' }\n";
  test('spring.mail is used by the first file in the project that sends mail, not the first file', () => {
    const s = scan({
      'build.gradle': BUILD,
      'src/main/resources/application.yml': 'spring:\n  mail:\n    host: smtp.corp.example\n',
      'src/main/java/A.java': 'class A { }\n',
      'src/main/java/B.java': 'class B { JavaMailSender s; }\n',
    });
    const o = s.outbound.find((x) => x.host === 'smtp.corp.example');
    expect(o?.callSite?.file).toBe('src/main/java/B.java');
  });

  test('a properties class read a host key; another class that names it makes the call', () => {
    const s = scan({
      'build.gradle': BUILD,
      'src/main/resources/application.yml': 'partner:\n  base-url: https://api.partner.example/v1\n',
      'src/main/java/PartnerProps.java': 'class PartnerProps { @Value("${partner.base-url}") String url; }\n',
      'src/main/java/Other.java': 'class Other { }\n',
      'src/main/java/Client.java': 'class Client { PartnerProps props; RestTemplate rt; }\n',
    });
    const o = s.outbound.find((x) => x.host === 'api.partner.example');
    expect(o?.callSite?.file).toBe('src/main/java/Client.java');
  });

  test('a host nobody calls out gets no call site, however many files are looked at', () => {
    const s = scan({
      'build.gradle': BUILD,
      'src/main/resources/application.yml': 'spring:\n  mail:\n    host: smtp.corp.example\npartner:\n  base-url: https://api.partner.example/v1\n',
      'src/main/java/A.java': 'class A { }\n',
      'src/main/java/B.java': 'class B { }\n',
      'src/main/java/PartnerProps.java': 'class PartnerProps { @Value("${partner.base-url}") String url; }\n',
      'src/main/java/Uses.java': 'class Uses { PartnerProps p; }\n',
      'src/main/java/AlsoUses.java': 'class AlsoUses { PartnerProps p; }\n',
    });
    expect(s.outbound.find((x) => x.host === 'smtp.corp.example')?.callSite).toBeNull();
    expect(s.outbound.find((x) => x.host === 'api.partner.example')?.callSite).toBeNull();
  });

  test('a constant naming a host is called out by another file that uses the constant', () => {
    const s = scan({
      ...NODE,
      'consts.js': 'const PARTNER_URL = "https://api.partner.example/v1";\nmodule.exports = { PARTNER_URL };\n',
      'plain.js': 'const x = 1;\n',
      'client.js': 'const { PARTNER_URL } = require("./consts");\nfetch(PARTNER_URL);\n',
    });
    const o = s.outbound.find((x) => x.host === 'api.partner.example');
    expect(o?.callSite?.file).toBe('client.js');
  });
});
