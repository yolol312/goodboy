// Track M (§19), M1: the read-only sandbox scan. Fixture projects are built in temp dirs.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanSandbox } from '../lib/sandbox-scan';
import type { SandboxOutbound, SandboxScan } from '../lib/sandbox-types';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>, init = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m1-')));
  tmpDirs.push(root);
  if (init) Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const host = (scan: SandboxScan, h: string): SandboxOutbound | undefined => scan.outbound.find((o) => o.host === h);

const SPRING_SECRETS = ['S3cr3t-DbPassw0rd', 'R3dis-Secret-Value', 'M41l-Secret', 'L-dap-Secret', 'K3y-Secret-Value'];

function springApp(): Record<string, string> {
  return {
    'build.gradle': `plugins {
  id 'org.springframework.boot' version '3.2.0'
  id 'java'
}
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web'
  implementation 'org.springframework.boot:spring-boot-starter-thymeleaf'
  implementation 'org.springframework.boot:spring-boot-starter-data-redis'
  implementation 'org.springframework.boot:spring-boot-starter-mail'
  implementation 'org.springframework.boot:spring-boot-starter-actuator'
  runtimeOnly 'org.postgresql:postgresql'
}
`,
    gradlew: '#!/bin/sh\n',
    'settings.gradle': "rootProject.name = 'shop'\n",
    'src/main/resources/application.yml': `server:
  port: 9090
  servlet:
    context-path: /shop
spring:
  datasource:
    url: jdbc:postgresql://db.internal.example:5432/shopdb
    username: shop
    password: S3cr3t-DbPassw0rd
  data:
    redis:
      host: redis.example.net
      port: 6379
      password: R3dis-Secret-Value
  mail:
    host: smtp.example.com
    port: 587
    username: mailer
    password: M41l-Secret
app:
  ldap:
    url: ldap://ldap.corp.example.com:389
    bind-password: L-dap-Secret
  partner:
    api-url: https://api.partner.example.com/v1
    api-key: K3y-Secret-Value
  callback: http://localhost:8080/callback
`,
    'src/main/java/com/acme/PartnerClient.java': `package com.acme;
import org.springframework.web.client.RestTemplate;
import org.springframework.beans.factory.annotation.Value;
public class PartnerClient {
  @Value("\${app.partner.api-url}") private String apiUrl;
  private final RestTemplate rest = new RestTemplate();
  public String rates() { return rest.getForObject(apiUrl + "/rates", String.class); }
}
`,
    'src/main/java/com/acme/LdapConfig.java': `package com.acme;
import org.springframework.ldap.core.support.LdapContextSource;
import org.springframework.beans.factory.annotation.Value;
public class LdapConfig {
  @Value("\${app.ldap.url}") private String url;
  LdapContextSource source() { LdapContextSource s = new LdapContextSource(); s.setUrl(url); return s; }
}
`,
    'src/main/java/com/acme/LegacyLdap.java': `package com.acme;
import javax.naming.directory.InitialDirContext;
public class LegacyLdap {
  // see https://docs.example.org/legacy for the protocol
  private static final String LEGACY_URL = "ldaps://203.0.113.7:636";
  void connect() throws Exception { new InitialDirContext(new java.util.Hashtable<>()); }
  static final String SELF = "http://localhost:8080/health";
}
`,
    'src/main/java/com/acme/MailService.java': `package com.acme;
import org.springframework.mail.javamail.JavaMailSender;
public class MailService {
  private final JavaMailSender sender;
  MailService(JavaMailSender sender) { this.sender = sender; }
}
`,
    'src/main/resources/templates/mail/welcome.html': `<html xmlns:th="http://www.thymeleaf.org">
<head><script src="https://cdn.jsdelivr.net/npm/htmx.org"></script></head>
<body><a href="https://shop.example.com/verify">Verify your address</a></body>
</html>
`,
  };
}

describe('M1 sandbox scan: Spring Boot Gradle app', () => {
  const scan = scanSandbox(repo(springApp()));

  test('detects the build, app and frameworks', () => {
    expect(scan.problems).toEqual([]);
    expect(scan.stack).toBe('jvm');
    expect(scan.frameworks).toEqual(expect.arrayContaining(['spring-boot', 'thymeleaf']));
    expect(scan.build.tool).toBe('gradle');
    expect(scan.build.runtimeVersion).toBe('21');
    expect(scan.build.depsCommand).toEqual(['./gradlew', '--no-daemon', 'dependencies']);
    expect(scan.build.buildCommand).toEqual(['./gradlew', '--no-daemon', 'bootJar']);
    expect(scan.build.testCommand).toEqual(['./gradlew', '--offline', 'test']);
    expect(scan.build.artifact).toBe('build/libs/*.jar');
    expect(scan.build.startCommand).toEqual(['java', '-jar', 'build/libs/*.jar']);
    expect(scan.app.port).toBe(9090);
    expect(scan.app.contextPath).toBe('/shop');
    expect(scan.app.healthPath).toBe('/shop/actuator/health');
    expect(scan.app.configFiles).toEqual(['src/main/resources/application.yml']);
  });

  test('finds the stores with their database names, keys and a version question', () => {
    expect(scan.stores.map((s) => s.kind).sort()).toEqual(['postgres', 'redis']);
    const pg = scan.stores.find((s) => s.kind === 'postgres')!;
    expect(pg.database).toBe('shopdb');
    expect(pg.version).toBe('16');
    expect(pg.configKeys).toEqual(expect.arrayContaining(['spring.datasource.url', 'spring.datasource.username', 'spring.datasource.password']));
    expect(pg.where).toEqual({ file: 'src/main/resources/application.yml', line: 7 });
    expect(scan.stores.find((s) => s.kind === 'redis')!.configKeys).toContain('spring.data.redis.host');
    expect(scan.questions.some((q) => q.startsWith('postgres: no version'))).toBe(true);
    // Stores are no outbound hosts.
    expect(host(scan, 'redis.example.net')).toBeUndefined();
    expect(host(scan, 'db.internal.example')).toBeUndefined();
  });

  test('finds outbound hosts by kind, call site and origin', () => {
    const smtp = host(scan, 'smtp.example.com')!;
    expect(smtp).toMatchObject({ kind: 'smtp', port: 587, hardcoded: false });
    expect(smtp.callSite?.file).toBe('src/main/java/com/acme/MailService.java');

    const api = host(scan, 'api.partner.example.com')!;
    expect(api).toMatchObject({ kind: 'http', scheme: 'https', hardcoded: false });
    expect(api.callSite?.file).toBe('src/main/java/com/acme/PartnerClient.java');

    const ldap = host(scan, 'ldap.corp.example.com')!;
    expect(ldap).toMatchObject({ kind: 'ldap', port: 389, hardcoded: false });
    expect(ldap.callSite?.file).toBe('src/main/java/com/acme/LdapConfig.java');

    const ip = host(scan, '203.0.113.7')!;
    expect(ip).toMatchObject({ kind: 'ldap', port: 636, hardcoded: true, ipLiteral: true });
    expect(ip.callSite).toEqual({ file: 'src/main/java/com/acme/LegacyLdap.java', line: 6 });

    // A link in a mail body is no call.
    const link = host(scan, 'shop.example.com')!;
    expect(link.callSite).toBeNull();
    expect(link.hardcoded).toBe(true);
  });

  test('leaves out local addresses, namespaces, CDN links and comments', () => {
    const hosts = scan.outbound.map((o) => o.host);
    for (const h of ['localhost', 'www.thymeleaf.org', 'cdn.jsdelivr.net', 'docs.example.org']) expect(hosts).not.toContain(h);
  });

  test('lists secret keys by name and never a value', () => {
    expect(scan.secretKeys).toEqual(
      expect.arrayContaining(['spring.datasource.password', 'spring.data.redis.password', 'spring.mail.password', 'app.ldap.bind-password', 'app.partner.api-key']),
    );
    expect(scan.secretKeys).not.toContain('app.partner.api-url');
    const json = JSON.stringify(scan);
    for (const v of SPRING_SECRETS) expect(json).not.toContain(v);
  });

  test('is read-only', () => {
    const root = repo(springApp());
    const before = Bun.spawnSync(['git', 'status', '--porcelain', '-uall'], { cwd: root, env: GIT_ENV }).stdout.toString();
    scanSandbox(root);
    const after = Bun.spawnSync(['git', 'status', '--porcelain', '-uall'], { cwd: root, env: GIT_ENV }).stdout.toString();
    expect(after).toBe(before);
  });
});

describe('M1 sandbox scan: Spring variants', () => {
  test('a Maven WAR with JSP, a compose file for the version, and profile files', () => {
    const scan = scanSandbox(
      repo({
        'pom.xml': `<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent>
  <packaging>war</packaging>
  <properties><java.version>1.8</java.version></properties>
  <dependencies>
    <dependency><artifactId>tomcat-embed-jasper</artifactId></dependency>
    <dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId></dependency>
  </dependencies></project>`,
        'docker-compose.yml': 'services:\n  db:\n    image: "mysql:5.7"\n',
        'src/main/webapp/WEB-INF/views/index.jsp': '<%@ taglib uri="http://java.sun.com/jsp/jstl/core" prefix="c" %>\n',
        'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://mysql.example.org:3306/legacy?useSSL=false&password=nope\nserver.port=8081\n',
        'src/main/resources/application-prod.properties': 'spring.datasource.url=jdbc:mysql://prod.example.org:3306/legacy\nserver.port=80\n',
      }),
    );
    expect(scan.build.tool).toBe('maven');
    expect(scan.build.runtimeVersion).toBe('8');
    expect(scan.build.artifact).toBe('target/*.war');
    expect(scan.build.buildCommand).toEqual(['mvn', '-B', '-o', 'package', '-DskipTests']);
    expect(scan.build.depsCommand).toEqual(['mvn', '-B', 'dependency:go-offline']);
    expect(scan.frameworks).toContain('jsp');
    expect(scan.app.port).toBe(8081); // the base file wins over a profile file
    expect(scan.stores).toHaveLength(1);
    expect(scan.stores[0]).toMatchObject({ kind: 'mysql', version: '5.7', database: 'legacy' });
    expect(scan.questions.some((q) => /WAR/.test(q))).toBe(true);
    expect(scan.outbound).toEqual([]); // the JSTL taglib URI is a name
    expect(JSON.stringify(scan)).not.toContain('nope');
  });

  test('a JDBC driver with no image is a problem; an embedded database is no store', () => {
    const scan = scanSandbox(
      repo({
        'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n",
        'src/main/resources/application.yml': 'spring:\n  datasource:\n    url: jdbc:oracle:thin:@//ora.example.com:1521/ORCL\n  other:\n    url: jdbc:h2:mem:test\n',
      }),
    );
    expect(scan.problems.some((p) => p.startsWith('unsupported store: jdbc:oracle'))).toBe(true);
    expect(scan.stores).toEqual([]);
  });

  test('YAML lists, several documents and placeholders with a default', () => {
    const scan = scanSandbox(
      repo({
        'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n",
        'src/main/resources/application.yml': `server:
  port: \${PORT:7070}
app:
  endpoints:
    - https://one.example.com/a
    - name: second
      url: https://two.example.com/b
---
spring:
  config:
    activate:
      on-profile: prod
server:
  port: 8000
`,
        'src/main/java/Client.java': 'class Client { java.net.http.HttpClient c = null; }\n',
      }),
    );
    expect(scan.app.port).toBe(7070);
    expect(host(scan, 'one.example.com')).toMatchObject({ kind: 'http', hardcoded: false });
    expect(host(scan, 'two.example.com')).toBeDefined();
  });

  test('a store the build names but the config does not is a store with questions', () => {
    const scan = scanSandbox(
      repo({
        'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-data-mongodb' }\n",
      }),
    );
    expect(scan.stores).toHaveLength(1);
    expect(scan.stores[0]).toMatchObject({ kind: 'mongo', version: '7', database: null, configKeys: [] });
    expect(scan.questions.some((q) => q.startsWith('mongo: a driver or client is a dependency'))).toBe(true);
  });
});

describe('M1 sandbox scan: Node app', () => {
  const files = {
    'package.json': JSON.stringify({
      name: 'storefront',
      engines: { node: '>=20.11' },
      scripts: { build: 'next build', start: 'next start', test: 'jest' },
      dependencies: { next: '14.0.0', react: '18.0.0', express: '4.0.0', pg: '8.0.0', ioredis: '5.0.0', axios: '1.0.0', nodemailer: '6.0.0' },
    }),
    'package-lock.json': '{}',
    '.env': `DATABASE_URL=postgres://app:Pw-S3cret@db.example.org:5432/appdb
REDIS_URL=redis://:redisPw@cache.example.org:6379
API_BASE_URL=https://api.thirdparty.example.com
SMTP_HOST=smtp.mailer.example.com
SMTP_PORT=2525
SESSION_SECRET=sess-S3cret
PORT=4100
`,
    'src/server.js': `const axios = require('axios');
const base = process.env.API_BASE_URL;
async function load() { return axios.get(base + '/items'); }
module.exports = { load };
`,
    'src/mailer.js': `const nodemailer = require('nodemailer');
const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) });
module.exports = t;
`,
  };
  const scan = scanSandbox(repo(files));

  test('detects build and app', () => {
    expect(scan.problems).toEqual([]);
    expect(scan.stack).toBe('node');
    expect(scan.frameworks).toEqual(expect.arrayContaining(['next', 'react', 'express']));
    expect(scan.build.tool).toBe('npm');
    expect(scan.build.runtimeVersion).toBe('20');
    expect(scan.build.depsCommand).toEqual(['npm', 'ci']);
    expect(scan.build.buildCommand).toEqual(['npm', 'run', 'build']);
    expect(scan.build.testCommand).toEqual(['npm', 'run', 'test']);
    expect(scan.build.startCommand).toEqual(['npm', 'run', 'start']);
    expect(scan.build.artifact).toBe('.next');
    expect(scan.app.port).toBe(4100);
    expect(scan.app.configFiles).toEqual(['.env']);
  });

  test('stores come from the URLs in .env, by key only', () => {
    expect(scan.stores.map((s) => `${s.kind}:${s.database}`).sort()).toEqual(['postgres:appdb', 'redis:null']);
    expect(scan.stores.find((s) => s.kind === 'postgres')!.configKeys).toEqual(['DATABASE_URL']);
    expect(scan.stores.find((s) => s.kind === 'redis')!.configKeys).toEqual(['REDIS_URL']);
  });

  test('outbound hosts are read where the env keys are used', () => {
    const api = host(scan, 'api.thirdparty.example.com')!;
    expect(api).toMatchObject({ kind: 'http', hardcoded: false });
    expect(api.callSite?.file).toBe('src/server.js');
    const smtp = host(scan, 'smtp.mailer.example.com')!;
    expect(smtp).toMatchObject({ kind: 'smtp', port: 2525 });
    expect(smtp.callSite?.file).toBe('src/mailer.js');
  });

  test('keeps secrets out', () => {
    expect(scan.secretKeys).toContain('SESSION_SECRET');
    const json = JSON.stringify(scan);
    for (const v of ['Pw-S3cret', 'redisPw', 'sess-S3cret']) expect(json).not.toContain(v);
  });

  test('a pnpm project with a Vite preview and no stated port', () => {
    const s = scanSandbox(
      repo({
        'package.json': JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview', test: 'vitest' }, dependencies: { vite: '5.0.0', react: '18.0.0' } }),
        'pnpm-lock.yaml': 'lockfileVersion: 9\n',
        '.nvmrc': 'v22.1.0\n',
      }),
    );
    expect(s.build.tool).toBe('pnpm');
    expect(s.build.depsCommand).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(s.build.startCommand).toEqual(['pnpm', 'run', 'preview']);
    expect(s.build.runtimeVersion).toBe('22');
    expect(s.build.artifact).toBe('dist');
    expect(s.app.port).toBe(4173);
  });
});

describe('M1 sandbox scan: FastAPI app', () => {
  const scan = scanSandbox(
    repo({
      'requirements.txt': 'fastapi==0.110\nuvicorn\nrequests\nsqlalchemy\npsycopg2-binary\npytest\n',
      '.python-version': '3.12.1\n',
      '.env': 'DATABASE_URL=postgresql+psycopg2://u:pw-hidden@pghost.example.com/ratesdb\nRATES_URL=https://rates.example.com/v1\n',
      'app/__init__.py': '',
      'app/main.py': `from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}
`,
      'app/client.py': `import os
import requests

def rates():
    return requests.get(os.environ["RATES_URL"] + "/today").json()
`,
      'app/notify.py': `import smtplib

def send(msg):
    with smtplib.SMTP("mail.corp.example.com", 25) as s:
        s.send_message(msg)
`,
    }),
  );

  test('detects build and app', () => {
    expect(scan.stack).toBe('python');
    expect(scan.frameworks).toEqual(expect.arrayContaining(['fastapi', 'sqlalchemy']));
    expect(scan.build.tool).toBe('pip');
    expect(scan.build.runtimeVersion).toBe('3.12');
    expect(scan.build.depsCommand).toEqual(['pip', 'install', '-r', 'requirements.txt']);
    expect(scan.build.testCommand).toEqual(['python', '-m', 'pytest']);
    expect(scan.build.startCommand).toEqual(['uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8000']);
    expect(scan.app.port).toBe(8000);
    expect(scan.app.healthPath).toBe('/health');
  });

  test('finds the store and the outbound hosts', () => {
    expect(scan.stores).toHaveLength(1);
    expect(scan.stores[0]).toMatchObject({ kind: 'postgres', database: 'ratesdb', configKeys: ['DATABASE_URL'] });
    const rates = host(scan, 'rates.example.com')!;
    expect(rates).toMatchObject({ kind: 'http', hardcoded: false });
    expect(rates.callSite?.file).toBe('app/client.py');
    const mail = host(scan, 'mail.corp.example.com')!;
    expect(mail).toMatchObject({ kind: 'smtp', hardcoded: true });
    expect(mail.callSite?.file).toBe('app/notify.py');
    expect(JSON.stringify(scan)).not.toContain('pw-hidden');
  });
});

describe('M1 sandbox scan: no usable project', () => {
  test('a dir with no build tool is a problem', () => {
    const scan = scanSandbox(repo({ 'README.md': '# hello\n' }));
    expect(scan.problems).toEqual([expect.stringContaining('no build tool found')]);
  });

  test('an unsupported stack is named', () => {
    const scan = scanSandbox(repo({ 'go.mod': 'module x\n' }));
    expect(scan.problems).toEqual([expect.stringContaining('unsupported stack: go')]);
  });

  test('a dir that is no git repository is a problem, not a throw', () => {
    const scan = scanSandbox(repo({ 'package.json': '{}' }, false));
    expect(scan.problems.length).toBeGreaterThan(0);
  });

  test('dependency and test dirs are not scanned', () => {
    const scan = scanSandbox(
      repo({
        'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
        'index.js': 'console.log(1)\n',
        'node_modules/lib/index.js': "fetch('https://leak.example.com/x')\n",
        'test/api.test.js': "fetch('https://only-in-tests.example.com/x')\n",
      }),
    );
    expect(scan.outbound).toEqual([]);
  });
});

describe('M1 sandbox scan: malformed config fails closed', () => {
  test('a broken YAML and a broken properties file do not throw and become questions', () => {
    const files = {
      'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n",
      'src/main/resources/application.yml': 'server:\n\tport: 8080\nspring:\n  mail:\n    host: "smtp.broken.example.com\n  data: [1, 2\nname: a\n   nested: b\n',
      'src/main/resources/application-dev.properties': 'this is not a properties file\nserver.port=8085\n\u0001binary\n',
    };
    let scan: SandboxScan | undefined;
    expect(() => (scan = scanSandbox(repo(files)))).not.toThrow();
    expect(scan!.questions.some((q) => q.startsWith('src/main/resources/application.yml:') && q.includes('could not be parsed'))).toBe(true);
    expect(scan!.questions.some((q) => q.startsWith('src/main/resources/application-dev.properties:') && q.includes('could not be parsed'))).toBe(true);
    expect(host(scan!, 'smtp.broken.example.com')).toBeUndefined();
  });

  test('an invalid package.json is a problem and the scan still returns', () => {
    const scan = scanSandbox(repo({ 'package.json': '{ not json' }));
    expect(scan.problems).toContain('package.json is not valid JSON');
  });
});
