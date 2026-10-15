import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyHost,
  classifyOutward,
  decideOutward,
  hostOf,
  isLocalHost,
  readHostRules,
  shellSegments,
  dropRedirects,
} from '../lib/outward-command';

// Track G stop rule R2 (plan §10.6).

describe('redirections', () => {
  test('`2>&1`, `<&3` and `&>` stay words; a lone `&` still separates', () => {
    expect(shellSegments('a b 2>&1')).toEqual([['a', 'b', '2>&1']]);
    expect(shellSegments('a <&3 b')).toEqual([['a', '<&3', 'b']]);
    expect(shellSegments('a &>/dev/null')).toEqual([['a', '&>/dev/null']]);
    expect(shellSegments('a &>> log')).toEqual([['a', '&>>', 'log']]);
    expect(shellSegments('a & b')).toEqual([['a'], ['b']]);
    expect(shellSegments('a && b')).toEqual([['a'], ['b']]);
  });

  test('dropRedirects removes operators and their targets', () => {
    expect(dropRedirects(['git', 'push', '>', 'out', '2>&1', 'origin'])).toEqual(['git', 'push', 'origin']);
    expect(dropRedirects(['curl', '-X', 'POST', 'u', '2>/dev/null', '&>>', 'log'])).toEqual(['curl', '-X', 'POST', 'u']);
    expect(dropRedirects(['cat', '<<EOF'])).toEqual(['cat']);
    expect(dropRedirects(['x', 'a>b'])).toEqual(['x', 'a>b']); // not an operator at the start
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(hosts?: string, remoteUrl?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-outward-'));
  tmpDirs.push(d);
  if (hosts !== undefined) {
    mkdirSync(join(d, '.goodboy'));
    writeFileSync(join(d, '.goodboy', 'hosts'), hosts);
  }
  if (remoteUrl) {
    mkdirSync(join(d, '.git'));
    writeFileSync(join(d, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
  return d;
}

const NO_RULES = { allow: [], production: [] };
const t = (cmd: string, cwd = '/nonexistent') => classifyOutward(cmd, cwd);
const one = (cmd: string, cwd?: string) => {
  const r = t(cmd, cwd);
  expect(r).toHaveLength(1);
  return r[0]!;
};

describe('shellSegments', () => {
  test('splits at unquoted separators and strips quotes', () => {
    expect(shellSegments(`curl -d 'a;b' https://x.io && echo "ok | fine"`)).toEqual([
      ['curl', '-d', 'a;b', 'https://x.io'],
      ['echo', 'ok | fine'],
    ]);
    // A substitution is read before the command it is part of, which keeps its text.
    expect(shellSegments('x=$(curl -X POST https://a.io/v)')).toEqual([['curl', '-X', 'POST', 'https://a.io/v'], ['x=$(curl -X POST https://a.io/v)']]);
  });
});

describe('hostOf', () => {
  test('urls, users, ports, ipv6', () => {
    expect(hostOf('https://user:pw@API.Example.io:8443/v1?q=1')).toBe('api.example.io');
    expect(hostOf('deploy@prod-1.corp.net')).toBe('prod-1.corp.net');
    expect(hostOf('http://[::1]:3000/')).toBe('::1');
    expect(hostOf('localhost:3000/health')).toBe('localhost');
  });
});

describe('curl, wget, httpie', () => {
  test('GET is a read; data or a non-GET method is mutating', () => {
    expect(one('curl https://api.stripe.com/v1/charges')).toEqual({ kind: 'curl', host: 'api.stripe.com', mutating: false });
    expect(one('curl -X POST https://api.stripe.com/v1/charges').mutating).toBe(true);
    expect(one('curl -XDELETE https://api.x.io/a').mutating).toBe(true);
    expect(one('curl -d amount=1 https://api.x.io/a').mutating).toBe(true);
    expect(one("curl --json '{}' https://api.x.io/a").mutating).toBe(true);
    expect(one('curl -G -d q=1 https://api.x.io/search').mutating).toBe(false);
    expect(one('curl -I https://x.io').mutating).toBe(false);
    expect(one('curl -s -H "Authorization: x" -o out.json https://x.io/a').host).toBe('x.io');
  });

  test('wget posts are mutating', () => {
    expect(one('wget https://x.io/file.tgz').mutating).toBe(false);
    expect(one('wget --post-data=a=1 https://x.io/f').mutating).toBe(true);
  });

  test('httpie: data items or a write method', () => {
    expect(one('http GET https://x.io/a').mutating).toBe(false);
    expect(one('http https://x.io/a name=bob').mutating).toBe(true);
    expect(one('http DELETE https://x.io/a/1').mutating).toBe(true);
    expect(one('http :3000/health').host).toBe('localhost');
    expect(one('http https://x.io/a Authorization:token').mutating).toBe(false);
  });
});

describe('ssh family', () => {
  test('ssh is a remote shell (mutating); scp/rsync mutate only toward the remote', () => {
    expect(one('ssh -i key.pem deploy@prod-1.corp.net "sudo systemctl restart app"')).toEqual({
      kind: 'ssh',
      host: 'prod-1.corp.net',
      mutating: true,
    });
    expect(one('scp build.tgz deploy@prod-1.corp.net:/srv/').mutating).toBe(true);
    expect(one('scp deploy@prod-1.corp.net:/var/log/app.log .').mutating).toBe(false);
    expect(one('rsync -avz dist/ web@static.corp.net:/var/www/').host).toBe('static.corp.net');
    expect(t('rsync -av src/ dst/')).toEqual([]);
  });
});

describe('git push', () => {
  test('host from the remote URL in .git/config', () => {
    const d = repo(undefined, 'git@github.com:me/app.git');
    expect(one('git push origin main', d)).toEqual({ kind: 'git push', host: 'github.com', mutating: true });
    const h = repo(undefined, 'https://gitlab.corp.net/team/app.git');
    expect(one('git push', h).host).toBe('gitlab.corp.net');
  });

  test('dry run is a read; other git commands are not outward', () => {
    expect(one('git push --dry-run origin main').mutating).toBe(false);
    expect(t('git status && git commit -m "push it"')).toEqual([]);
  });

  test('an unknown remote is still outward', () => {
    expect(one('git push upstream main', repo()).host).toBe('git-remote:upstream');
  });
});

describe('kubernetes, IaC, registries, forges, clouds, databases', () => {
  test('kubectl/helm mutating verbs by context; local contexts are local', () => {
    expect(one('kubectl get pods').mutating).toBe(false);
    expect(one('kubectl --context prod-eu apply -f deploy.yaml')).toEqual({ kind: 'kubectl', host: 'kube:prod-eu', mutating: true });
    expect(one('kubectl delete pod x').host).toBe('kube:current');
    expect(one('helm upgrade app ./chart --kube-context=kind-dev').host).toBe('kube:kind-dev');
    expect(isLocalHost('kube:kind-dev')).toBe(true);
    expect(isLocalHost('kube:current')).toBe(false);
  });

  test('terraform/tofu/pulumi', () => {
    expect(one('terraform plan').mutating).toBe(false);
    expect(one('terraform apply -auto-approve').mutating).toBe(true);
    expect(one('tofu state rm aws_instance.x')).toEqual({ kind: 'terraform', host: 'terraform', mutating: true });
    expect(one('pulumi up --yes').mutating).toBe(true);
  });

  test('publishing and image pushes', () => {
    expect(one('npm publish --access public')).toEqual({ kind: 'npm publish', host: 'registry.npmjs.org', mutating: true });
    expect(t('npm install && npm test')).toEqual([]);
    expect(one('docker push ghcr.io/me/app:1').host).toBe('ghcr.io');
    expect(one('docker push me/app:1').host).toBe('docker.io');
    expect(one('docker push localhost:5000/app').host).toBe('localhost');
    expect(t('docker build -t app .')).toEqual([]);
    expect(one('cargo publish').host).toBe('crates.io');
  });

  test('gh/glab writes vs reads', () => {
    expect(one('gh pr create --title x --body y')).toEqual({ kind: 'gh pr', host: 'github.com', mutating: true });
    expect(one('gh pr view 12').mutating).toBe(false);
    expect(one('gh api repos/me/app').mutating).toBe(false);
    expect(one('gh api -X DELETE repos/me/app').mutating).toBe(true);
    expect(one('gh api repos/me/app/issues -f title=x').mutating).toBe(true);
    expect(one('glab mr merge 3').host).toBe('gitlab.com');
  });

  test('cloud CLIs by verb; s3 by destination; localstack endpoint is local', () => {
    expect(one('aws ec2 describe-instances').mutating).toBe(false);
    expect(one('aws ec2 terminate-instances --instance-ids i-1').mutating).toBe(true);
    expect(one('aws s3 cp s3://bucket/a.txt .').mutating).toBe(false);
    expect(one('aws s3 sync dist/ s3://bucket/').mutating).toBe(true);
    expect(one('aws --endpoint-url http://localhost:4566 s3 rm s3://b/a').host).toBe('localhost');
    expect(one('gcloud run deploy api --image x').mutating).toBe(true);
    expect(one('gcloud compute instances list').mutating).toBe(false);
    expect(one('az vm delete -g rg -n vm1').host).toBe('azure');
  });

  test('database clients: remote host, or a URI; dumps are reads; a socket is local', () => {
    expect(one('psql -h db.prod.corp.net -U app -c "DELETE FROM users"')).toEqual({ kind: 'psql', host: 'db.prod.corp.net', mutating: true });
    expect(one('psql postgres://app@db.corp.net:5432/app').host).toBe('db.corp.net');
    expect(one('pg_dump -h db.corp.net app').mutating).toBe(false);
    expect(t('psql -U app -c "select 1"')).toEqual([]);
    expect(one('redis-cli -h cache.corp.net FLUSHALL').mutating).toBe(true);
    expect(one('mysql -hdb.corp.net -e "drop table x"').host).toBe('db.corp.net');
  });

  test('prefixes and chains', () => {
    expect(one('sudo -u deploy FOO=1 curl -X PUT https://api.x.io/a').mutating).toBe(true);
    expect(t('cd app && npm test; curl -X POST https://hooks.slack.com/x | cat')).toHaveLength(1);
    expect(t('echo curl -X POST https://x.io')).toEqual([]);
  });
});

describe('host classes and decisions', () => {
  test('built-in local and reserved names; private IPs are not local', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '::1', 'api.test', 'x.invalid', 'example.com', 'host.docker.internal']) {
      expect([h, isLocalHost(h)]).toEqual([h, true]);
    }
    for (const h of ['10.0.0.5', '192.168.1.10', 'localhost.corp.net', 'example.co']) {
      expect([h, isLocalHost(h)]).toEqual([h, false]);
    }
  });

  test('.goodboy/hosts: allow and production patterns; production wins', () => {
    const d = repo('# hosts\nallow staging.corp.net\nallow *.dev.corp.net\nproduction api.corp.net\nproduction *.prod.corp.net\nallow *.prod.corp.net\n');
    const rules = readHostRules(join(d));
    expect(classifyHost('staging.corp.net', rules)).toBe('allow');
    expect(classifyHost('a.dev.corp.net', rules)).toBe('allow');
    expect(classifyHost('dev.corp.net', rules)).toBe('unlisted');
    expect(classifyHost('api.corp.net', rules)).toBe('production');
    expect(classifyHost('db.prod.corp.net', rules)).toBe('production');
    expect(classifyHost('other.io', rules)).toBe('unlisted');
  });

  test('rules are found from a subdirectory', () => {
    const d = repo('allow staging.corp.net\n');
    mkdirSync(join(d, 'pkg', 'a'), { recursive: true });
    expect(readHostRules(join(d, 'pkg', 'a')).allow).toEqual(['staging.corp.net']);
  });

  test('decisions: reads pass; unlisted writes deny in subagents and advise in main; production denies both', () => {
    const rules = { allow: ['staging.corp.net'], production: ['api.corp.net'] };
    const read = t('curl https://api.corp.net/health');
    expect(decideOutward(read, rules, true).action).toBe('pass');
    const unlisted = t('curl -X POST https://api.stripe.com/v1/charges');
    expect(decideOutward(unlisted, rules, true).action).toBe('deny-unlisted');
    expect(decideOutward(unlisted, rules, false).action).toBe('advise');
    const prod = t('curl -X POST https://api.corp.net/v1/x');
    expect(decideOutward(prod, rules, false).action).toBe('deny-production');
    expect(decideOutward(t('curl -X POST https://staging.corp.net/v1/x'), rules, true).action).toBe('pass');
    expect(decideOutward(t('curl -X POST http://localhost:3000/x'), NO_RULES, true).action).toBe('pass');
  });
});
