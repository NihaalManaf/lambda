// Python extractor: an AST port of the research scout's scan.py, run as `python3 -I -c SCRIPT repo ignore [overrides]`.
// Kept as a string constant so output file tracing never picks it up. Resolves constants, f-strings, builder
// functions and imports one hop, mounts FastAPI routers to full paths, and marks idempotency/auth signals.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Consumer, Kw, Mark } from "./types";

export interface PyOut {
  pubs: { file: string; line: number; end: number; fn: string; call: string; kw: Kw; sink?: boolean; via?: string | null; wrapper?: boolean }[];
  crons: { file: string; line: number; kw: Kw; marks?: Mark[]; reach?: string[]; hline?: number }[];
  routes: { file: string; line: number; fn: string; method: string; path: string; auth: Consumer["auth"]; marks: Mark[]; reach: string[] }[];
  lambdas: { file: string; line: number; fn: string; sqs: boolean; marks: Mark[]; reach: string[] }[];
  envs: Record<string, string[]>;
  parsed: number;
}

export const SCRIPT = String.raw`
import ast, sys, os, json, re, bisect, gc
gc.disable()
root = os.path.abspath(sys.argv[1])
ignore = set(json.loads(sys.argv[2])) if len(sys.argv) > 2 else set()
ov = json.load(open(sys.argv[3])) if len(sys.argv) > 3 and sys.argv[3] else {}  # rel -> text | None (git HEAD replay)
def read(p):
    r = os.path.relpath(p, root)
    if r in ov: return ov[r] or ''
    return open(p, encoding='utf-8', errors='replace').read()
SKIP = ignore | {'site-packages', 'tests', 'test', 'node_modules'}
PRE = re.compile(r'QStash|qstash|batch_enqueue|CronJob\(|send_message|Receiver\(|verify_qstash_sig|lambda_handler|include_router')
PUB = {'publish_json', 'batch_json', 'batch_enqueue', 'enqueue_json', 'create_json', 'publish', 'enqueue', 'send_message', 'send_message_batch'}
QHOLD = {'message', 'schedule', 'schedules', 'queue', 'queues'}
MARKS = {
    'lock': ('pg_advisory', 'pg_try_advisory', 'advisory_lock', 'advisory_xact_lock', 'for update', 'skip locked', 'acquire_lock', '.lock('),
    'conflict': ('on conflict',),
    'dedup': ('already_processed', 'idempoten', 'processed_messages', 'upstash-message-id'),
    'version': ('generation !=', 'generation ==', 'generation <', 'version !=', 'version ==', 'version <', 'generation = %(', 'version = %('),
    'retried': ('upstash-retried',),
    'nonretry': ('nonretryable', ' 489'),
    'sig': ('verify_qstash_sig', 'receiver('),
    'svc': ('require_service_role', 'require_user_or_service'),
}
ENVQ = re.compile(r'''environ(?:\.get)?[\[(]\s*['"]([A-Z0-9_]*(?:SQS|QUEUE)[A-Z0-9_]*)['"]|getenv\(\s*['"]([A-Z0-9_]*(?:SQS|QUEUE)[A-Z0-9_]*)['"]''')

files = {}  # top -> dotted -> abs path
allpy = []
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in SKIP and not d.startswith('.')]
    for f in fn:
        if not f.endswith('.py'): continue
        p = os.path.join(dp, f)
        rel = os.path.relpath(p, root)
        if rel in ov and ov[rel] is None: continue
        parts = rel[:-3].split(os.sep)
        top = parts[0] if len(parts) > 1 else ''
        dotted = parts[1:] if top else parts
        if dotted and dotted[-1] == '__init__': dotted = dotted[:-1]
        files.setdefault(top, {})['.'.join(dotted)] = p
        allpy.append(p)
for rel, t in ov.items():
    p = os.path.join(root, rel)
    if t is None or not rel.endswith('.py') or p in allpy: continue
    parts = rel[:-3].split('/')
    top = parts[0] if len(parts) > 1 else ''
    dotted = [x for x in (parts[1:] if top else parts) if x != '__init__']
    files.setdefault(top, {})['.'.join(dotted)] = p
    allpy.append(p)

class Mod:
    def __init__(s, path):
        s.path = path; s.rel = os.path.relpath(path, root)
        parts = s.rel[:-3].split(os.sep)
        s.top = parts[0] if len(parts) > 1 else ''
        d = parts[1:] if s.top else parts
        s.pkg = d[:-1]
        s.text = read(path)
        s.lines = s.text.split('\n')
        try: s.tree = ast.parse(s.text)
        except Exception: s.tree = None
        s.consts, s.imports, s.funcs, s.routers, s.mounts = {}, {}, {}, {}, []
        if s.tree is None: return
        for n in s.tree.body:
            if isinstance(n, (ast.Assign, ast.AnnAssign)):
                tg = n.targets if isinstance(n, ast.Assign) else [n.target]
                for t in tg:
                    if isinstance(t, ast.Name) and n.value is not None: s.consts[t.id] = n.value
            elif isinstance(n, ast.ImportFrom):
                base = s.absmod(n.module, n.level)
                for a in n.names: s.imports[a.asname or a.name] = (base, a.name)
            elif isinstance(n, ast.Import):
                for a in n.names: s.imports[a.asname or a.name.split('.')[0]] = (a.name if a.asname else a.name.split('.')[0], None)
        for n in s.tree.body:
            for f in (n.body if isinstance(n, ast.ClassDef) else [n]):
                if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f.name not in s.funcs: s.funcs[f.name] = f
            c = n.value if isinstance(n, ast.Expr) else None
            if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == 'include_router' and isinstance(c.func.value, ast.Name) and c.args:
                s.mounts.append((c.func.value.id, c.args[0], c))
        for k, v in s.consts.items():
            if isinstance(v, ast.Call) and cname(v) == 'APIRouter': s.routers[k] = v
    def absmod(s, m, level):
        if not level: return m or ''
        base = list(s.pkg)
        if level > 1: base = base[:len(base) - (level - 1)]
        return '.'.join(base + ([m] if m else []))
    def src(s, n): return '\n'.join(s.lines[n.lineno - 1:(n.end_lineno or n.lineno)])

def cname(c):
    f = c.func
    return f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else None

cache = {}
def mod(path):
    if path not in cache: cache[path] = Mod(path)
    return cache[path]
def find(top, dotted):
    p = files.get(top, {}).get(dotted)
    return mod(p) if p else None

def lookup(m, name, depth=0):
    """name in module m -> ('const'|'func'|'mod', module, node)"""
    if m is None or depth > 3: return None
    if name in m.consts: return ('const', m, m.consts[name])
    if name in m.funcs and m.funcs[name] in m.tree.body: return ('func', m, m.funcs[name])
    if name in m.imports:
        mm, nm = m.imports[name]
        if nm is None: return ('mod', find(m.top, mm), None)
        sub = find(m.top, mm + '.' + nm if mm else nm)
        if sub is not None: return ('mod', sub, None)
        return lookup(find(m.top, mm), nm, depth + 1)
    return None

def short(n, k=40): return ast.unparse(n)[:k]

def envname(n):
    if isinstance(n, ast.Subscript) and 'environ' in short(n.value) and isinstance(n.slice, ast.Constant): return n.slice.value
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ('get', 'getenv') and n.args and isinstance(n.args[0], ast.Constant) and ('environ' in short(n.func.value) or n.func.attr == 'getenv'):
        return n.args[0].value
    return None

def localval(fn, name, line):
    best = None
    if fn is None: return None
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and n.lineno < line:
            for t in n.targets:
                if isinstance(t, ast.Name) and t.id == name and (best is None or n.lineno > best.lineno): best = n
        elif isinstance(n, ast.AnnAssign) and n.value is not None and isinstance(n.target, ast.Name) and n.target.id == name and n.lineno < line:
            if best is None or n.lineno > best.lineno: best = n
    return best.value if best is not None else None

def retexprs(fn):
    """every return value of fn itself (not of nested defs), source order"""
    out, todo = [], list(ast.iter_child_nodes(fn))
    while todo:
        n = todo.pop(0)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)): continue
        if isinstance(n, ast.Return) and n.value is not None: out.append(n.value)
        todo.extend(ast.iter_child_nodes(n))
    return out

# a builder with several returns renders as \x00a\x01b\x02; alts() fans a url out, first() keeps one
ALT = re.compile('\x00([^\x00\x02]*)\x02')
def alts(s):
    if not isinstance(s, str): return [s]
    mt = ALT.search(s)
    if not mt: return [s]
    out = []
    for a in mt.group(1).split('\x01'):
        for r in alts(s[:mt.start()] + a + s[mt.end():]):
            if r not in out: out.append(r)
    return out[:8]
def first(v):
    if isinstance(v, dict): return {k: first(x) for k, x in v.items()}
    return alts(v)[0] if isinstance(v, str) else v

class Ctx:
    def __init__(s, m, fn=None, sub=None, line=10**9): s.m, s.fn, s.sub, s.line = m, fn, sub or {}, line

def isnone(n, c):
    """None literal, or a param bound to / defaulting to None"""
    if isinstance(n, ast.Constant): return n.value is None
    if not isinstance(n, ast.Name): return False
    if n.id in c.sub:
        a = c.sub[n.id]
        return isnone(*a) if isinstance(a, tuple) else isnone(a, c)
    if c.fn is None: return False
    a = c.fn.args
    pos = a.posonlyargs + a.args
    for p, d in list(zip(pos[len(pos) - len(a.defaults):], a.defaults)) + list(zip(a.kwonlyargs, a.kw_defaults)):
        if p.arg == n.id: return isinstance(d, ast.Constant) and d.value is None
    return False

def node_of(n, c, depth):
    """follow Name -> assigned expression"""
    if isinstance(n, ast.IfExp): return node_of(n.orelse if isinstance(n.body, ast.Constant) and n.body.value is None else n.body, c, depth + 1)
    if isinstance(n, ast.BoolOp):
        vs = [v for v in n.values if not isnone(v, c)]
        return node_of(vs[0], c, depth + 1) if len(vs) == 1 else n
    if isinstance(n, ast.Name) and depth < 4:
        if n.id in c.sub:
            a = c.sub[n.id]
            return a[0] if isinstance(a, tuple) else a
        v = localval(c.fn, n.id, getattr(n, 'lineno', c.line) or c.line)
        if v is not None and v is not n: return node_of(v, c, depth + 1)
        r = lookup(c.m, n.id)
        if r and r[0] == 'const': return node_of(r[2], Ctx(r[1]), depth + 1)
    return n

def render(n, c, depth=0):
    if depth > 6: return '{' + short(n, 30) + '}'
    if isinstance(n, ast.BoolOp):
        # x or os.environ[...]: the first operand that looks like a url wins, else the first non-empty one
        rs = [render(v, c, depth + 1) for v in n.values if not isnone(v, c)] or ['']
        return next((r for r in rs if r.startswith(('{env:', 'http', '/'))), next((r for r in rs if r), rs[-1]))
    if isinstance(n, ast.IfExp): return render(node_of(n, c, 3), c, depth + 1)
    if isinstance(n, ast.Constant): return '' if n.value is None else n.value if isinstance(n.value, str) else str(n.value)
    e = envname(n)
    if e: return '{env:' + e + '}'
    if isinstance(n, ast.JoinedStr):
        out = ''
        for v in n.values:
            out += v.value if isinstance(v, ast.Constant) else render(v.value, c, depth + 1)
        return out
    if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add): return render(n.left, c, depth + 1) + render(n.right, c, depth + 1)
    if isinstance(n, ast.Name):
        if n.id in c.sub:
            a = c.sub[n.id]
            return render(a[0], a[1], depth + 1) if isinstance(a, tuple) else render(a, c, depth + 1)
        v = localval(c.fn, n.id, getattr(n, 'lineno', c.line))
        if v is not None: return render(v, Ctx(c.m, c.fn, c.sub, getattr(v, 'lineno', c.line)), depth + 1)
        r = lookup(c.m, n.id)
        if r and r[0] == 'const': return render(r[2], Ctx(r[1]), depth + 1)
        return '{' + n.id + '}'
    if isinstance(n, ast.Attribute):
        if isinstance(n.value, ast.Name):
            r = lookup(c.m, n.value.id)
            if r and r[0] == 'mod' and r[1] is not None:
                rr = lookup(r[1], n.attr)
                if rr and rr[0] == 'const': return render(rr[2], Ctx(rr[1]), depth + 1)
        return '{' + n.attr + '}'
    if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Call): return render(n.value, c, depth + 1)
    if isinstance(n, ast.Call):
        f = n.func
        if isinstance(f, ast.Attribute) and f.attr == 'get_queue_url':
            q = next((k.value for k in n.keywords if k.arg == 'QueueName'), None)
            if q is not None: return render(q, c, depth + 1)
        if isinstance(f, ast.Attribute) and f.attr in ('rstrip', 'strip', 'lstrip', 'lower', 'removesuffix'): return render(f.value, c, depth + 1)
        if isinstance(f, ast.Name) and f.id == 'str' and n.args: return render(n.args[0], c, depth + 1)
        r = callee(n, c.m)
        if r and r[0] == 'func':
            fd = r[2]; exs = retexprs(fd)[:4]
            if exs:
                sub = bind(fd, n, c, r[1])
                rs = []
                for ex in exs:
                    v = render(ex, Ctx(r[1], fd, sub, ex.lineno), depth + 1)
                    if v and v not in rs: rs.append(v)
                return '' if not rs else rs[0] if len(rs) == 1 else '\x00' + '\x01'.join(rs) + '\x02'
        return '{' + (cname(n) or 'call') + '}'
    return '{' + short(n, 30) + '}'

def callee(call, m):
    """the function a call resolves to: ('func', module, def) or None"""
    f = call.func
    if isinstance(f, ast.Name): return ('func', m, m.funcs[f.id]) if f.id in m.funcs else lookup(m, f.id)
    if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
        rm = lookup(m, f.value.id)
        if rm and rm[0] == 'mod' and rm[1] is not None: return lookup(rm[1], f.attr)
    return None

def bind(fd, call, c, fm):
    """param -> (arg node, ctx): positional, keyword, then defaults"""
    a = fd.args
    params = [x.arg for x in a.posonlyargs + a.args]
    if params and params[0] in ('self', 'cls') and isinstance(call.func, ast.Attribute): params = params[1:]
    sub = {}
    for i, x in enumerate(call.args):
        if i < len(params) and not isinstance(x, ast.Starred): sub[params[i]] = (x, c)
    for k in call.keywords:
        if k.arg: sub[k.arg] = (k.value, c)
    allp = [x.arg for x in a.posonlyargs + a.args]
    for p, d in list(zip(allp[len(allp) - len(a.defaults):], a.defaults)) + [(p.arg, d) for p, d in zip(a.kwonlyargs, a.kw_defaults) if d is not None]:
        sub.setdefault(p, (d, Ctx(fm)))
    return sub

def scalar(n, c, depth=0):
    if isinstance(n, ast.Name) and n.id in c.sub:
        a = c.sub[n.id]
        return scalar(a[0], a[1], depth) if isinstance(a, tuple) else scalar(a, c, depth)
    n = node_of(n, c, 0)
    if isinstance(n, ast.Constant): return n.value
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub) and isinstance(n.operand, ast.Constant): return -n.operand.value
    if isinstance(n, ast.Dict) and depth < 2:
        return {k.value: scalar(v, c, depth + 1) for k, v in zip(n.keys, n.values) if isinstance(k, ast.Constant)}
    if isinstance(n, ast.Call) and cname(n) in ('FlowControl', 'dict') and depth < 2:
        return {k.arg: scalar(k.value, c, depth + 1) for k in n.keywords if k.arg}
    if isinstance(n, (ast.JoinedStr, ast.BinOp, ast.BoolOp, ast.Attribute, ast.Subscript, ast.Name, ast.Call)):
        r = render(n, c)
        return r
    return '{' + short(n, 40) + '}'

def kwmap(call, c):
    return {k.arg: scalar(k.value, c) for k in call.keywords if k.arg and k.arg not in ('body', 'bodies', 'headers', 'Entries', 'messages', 'failure_callback_headers', 'callback_headers', 'MessageBody')}

def nodes(m):
    todo = [(m.tree, [])]
    while todo:
        n, st = todo.pop()
        for ch in ast.iter_child_nodes(n):
            yield ch, st
            todo.append((ch, st + [ch] if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) else st))

def ispub(call):
    f = call.func
    if not isinstance(f, ast.Attribute):
        return isinstance(f, ast.Name) and f.id == 'batch_enqueue'
    a = f.attr
    if a not in PUB: return False
    if a in ('send_message', 'send_message_batch'): return any(k.arg == 'QueueUrl' for k in call.keywords)
    if a in ('publish_json', 'batch_json', 'enqueue_json', 'batch_enqueue'): return True
    holder = f.value.attr if isinstance(f.value, ast.Attribute) else f.value.id if isinstance(f.value, ast.Name) else ''
    return holder in QHOLD or 'qstash' in holder.lower()

def sitekw(n, c):
    """(kw, url node) for a publish call or a url dict"""
    if isinstance(n, ast.Call):
        return kwmap(n, c), next((k.value for k in n.keywords if k.arg in ('url', 'destination')), None)
    kw = {k.value: scalar(v, c) for k, v in zip(n.keys, n.values) if isinstance(k, ast.Constant) and k.value not in ('body', 'headers')}
    return kw, next((v for k, v in zip(n.keys, n.values) if isinstance(k, ast.Constant) and k.value == 'url'), None)

def emit(m, st, line, end, call, kw, w=None):
    """one site per distinct url the expression can take"""
    uk = 'url' if 'url' in kw else 'destination' if 'destination' in kw else None
    out = []
    for u in (alts(kw[uk]) if uk else [None]):
        k2 = {k: (u if k == uk else first(v)) for k, v in kw.items()}
        x = dict(file=m.rel, line=line, end=end, fn='.'.join(f.name for f in st), call=call, kw=k2)
        if w: x['_w'] = w
        pubs.append(x); out.append(x)
    if st: prodfns.add(m.rel + ':' + st[-1].name)
    return out

wrappers = {}  # (path, fn name) -> publish helper whose url comes from a param
pubs, crons, lambdas, prodfns = [], [], [], set()
for p in allpy:
    try: t = read(p)
    except Exception: continue
    if not PRE.search(t): continue
    m = mod(p)
    if m.tree is None: continue
    for n, st in nodes(m):
        fn = st[-1] if st else None
        if isinstance(n, ast.Call) and cname(n) == 'CronJob' and isinstance(n.func, ast.Name):
            c = Ctx(m, fn, None, n.lineno)
            kw = {}
            for k in n.keywords:
                if not k.arg or k.arg in ('body', 'extra_headers'): continue
                kw[k.arg] = k.value.id if k.arg == 'handler' and isinstance(k.value, ast.Name) else first(scalar(k.value, c))
            crons.append(dict(file=m.rel, line=n.lineno, kw=kw))
            continue
        isd = isinstance(n, ast.Dict) and 'url' in (keys := {k.value for k in n.keys if isinstance(k, ast.Constant)}) and bool({'body', 'flow_control', 'retries', 'delay', 'deduplication_id'} & keys)
        if isinstance(n, ast.Call) and ispub(n) or isd:
            c = Ctx(m, fn, None, n.lineno)
            name = 'dict' if isd else n.func.attr if isinstance(n.func, ast.Attribute) else n.func.id
            kw, u = sitekw(n, c)
            if name == 'create_json' and all(re.fullmatch(r'\{[^{}]*\}', str(first(kw.get(k, '{}')))) for k in ('destination', 'cron')): continue
            xs = emit(m, st, n.lineno, n.end_lineno, name, kw)
            params = {a.arg for a in fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs} if fn else set()
            bare = isinstance(u, ast.Name) and u.id in params
            ustr = str(kw.get('url', kw.get('destination', '')))
            # a param spliced into the url (not a /{id} segment) means the callers pick the target
            refs = {x.id for x in ast.walk(u) if isinstance(x, ast.Name)} & params if u is not None else set()
            if fn and (bare or any(re.search(r'(^|[^/])\{' + re.escape(r) + r'\}', ustr) for r in refs)):
                wrappers[(m.path, fn.name)] = dict(m=m, fn=fn, node=n, call=name, bare=bare, sites=xs, key=(m.rel, '.'.join(f.name for f in st)))
                if bare:
                    for x in xs: x['wrapper'] = True
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == 'lambda_handler':
            body = m.src(n)
            lambdas.append(dict(file=m.rel, line=n.lineno, fn=n.name, sqs='Records' in body or 'batchItemFailures' in body))

# expand publish helpers: each call site becomes a site, its url args substituted into the helper's url
wnames = {k[1] for k in wrappers}
for p in allpy if wrappers else []:
    try: t = read(p)
    except Exception: continue
    if not any(nm + '(' in t for nm in wnames): continue
    m = mod(p)
    if m.tree is None: continue
    for n, st in nodes(m):
        if not (isinstance(n, ast.Call) and cname(n) in wnames): continue
        r = callee(n, m)
        w = wrappers.get((r[1].path, r[2].name)) if r and r[0] == 'func' and r[1] is not None else None
        if not w or w['fn'] is not r[2] or (st and st[-1] is w['fn']): continue
        sub = bind(w['fn'], n, Ctx(m, st[-1] if st else None, None, n.lineno), w['m'])
        kw, _ = sitekw(w['node'], Ctx(w['m'], w['fn'], sub, w['node'].lineno))
        emit(m, st, n.lineno, n.end_lineno, w['call'], kw, w['key'])
        for x in w['sites']: x['wrapper'] = True

# mark sinks: a publish call with no url whose function also builds url dicts
dictfns = {(x['file'], x['fn']) for x in pubs if x['call'] == 'dict'}
for x in pubs:
    if x['call'] != 'dict' and not any(k in x['kw'] for k in ('url', 'destination', 'QueueUrl', 'queue')) and (x['file'], x['fn']) in dictfns:
        x['sink'] = True
sinkcall = {(x['file'], x['fn']): x['call'] for x in pubs if x.get('sink')}
for x in pubs:
    w = x.pop('_w', None)
    if x['call'] == 'dict': x['via'] = sinkcall.get(w or (x['file'], x['fn']))

# ---------- marks + reach ----------
CALLRX = re.compile(r'(?<![\w.])([A-Za-z_]\w*)(?:\.(\w+))?\s*\(')
ARGRX = re.compile(r'[(,]\s*([A-Za-z_]\w*)\s*(?=[,)])')
def callees(m, fn):
    out = []
    src = m.src(fn)
    for a, b in set(CALLRX.findall(src)) | {(x, '') for x in ARGRX.findall(src)}:
        r = None
        if a == fn.name and not b: continue
        if not b:
            r = ('func', m, m.funcs[a]) if a in m.funcs else lookup(m, a) if a in m.imports else None
        elif a == 'self' and b in m.funcs:
            r = ('func', m, m.funcs[b])
        elif a in m.imports:
            rm = lookup(m, a)
            if rm and rm[0] == 'mod' and rm[1] is not None and rm[1].tree is not None and b in rm[1].funcs: r = ('func', rm[1], rm[1].funcs[b])
        if r and r[0] == 'func' and r[1] is not None: out.append((r[1], r[2]))
    return out

own = {}
def info(m, fn):
    key = m.rel + ':' + fn.name
    if key not in own:
        if not hasattr(m, 'hits'):
            low, m.hits = m.text.lower(), []
            for k, words in MARKS.items():
                for w in words:
                    i = low.find(w)
                    while i >= 0:
                        m.hits.append((low.count('\n', 0, i) + 1, k)); i = low.find(w, i + 1)
            m.hits.sort()
        lo = bisect.bisect_left(m.hits, (fn.lineno, ''))
        hi = bisect.bisect_right(m.hits, (fn.end_lineno, '~'))
        own[key] = ({k for _, k in m.hits[lo:hi]}, callees(m, fn))
    return key, own[key]

def analyze(m, fn):
    marks, reach, seen, front = set(), set(), set(), [(m, fn)]
    for depth in range(3):
        nxt = []
        for mm, ff in front:
            key, (mk, cs) = info(mm, ff)
            if key in seen: continue
            seen.add(key); marks |= mk
            if key in prodfns: reach.add(key)
            nxt += cs
        front = nxt
    return marks, reach

# ---------- routes ----------
METHODS = {'get', 'post', 'put', 'patch', 'delete', 'api_route'}
def authtext(m, node):
    """unparse + resolve annotation aliases one hop"""
    if node is None: return ''
    t = ast.unparse(node)
    for nm in re.findall(r'\b[A-Z]\w+\b', t):
        r = lookup(m, nm)
        if r and r[0] == 'const': t += ' ' + ast.unparse(r[2])
    return t

def routes_of(m):
    out = []
    if m.tree is None: return out
    for fn in m.funcs.values():
        for d in fn.decorator_list:
            if not (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr in METHODS and isinstance(d.func.value, ast.Name)): continue
            path = d.args[0].value if d.args and isinstance(d.args[0], ast.Constant) else next((k.value.value for k in d.keywords if k.arg == 'path' and isinstance(k.value, ast.Constant)), None)
            if not isinstance(path, str): continue
            deps = ' '.join(authtext(m, k.value) for k in d.keywords if k.arg == 'dependencies')
            args = fn.args.args + fn.args.kwonlyargs
            deps += ' ' + ' '.join(authtext(m, a.annotation) for a in args) + ' ' + ' '.join(authtext(m, x) for x in fn.args.defaults + [x for x in fn.args.kw_defaults if x is not None])
            out.append(dict(router=d.func.value.id, path=path, method=d.func.attr, fn=fn, deps=deps))
    return out

def rprefix(m, var):
    c = m.routers.get(var)
    if c is None: return '', ''
    pre = next((k.value.value for k in c.keywords if k.arg == 'prefix' and isinstance(k.value, ast.Constant)), '')
    deps = ' '.join(authtext(m, k.value) for k in c.keywords if k.arg == 'dependencies')
    return pre, deps

routes = []
appmods = [mod(p) for p in allpy if os.path.basename(p) in ('app.py', 'main.py', 'server.py') and 'FastAPI(' in read(p)]
seenr = set()
def mount(m, var, prefix, deps, depth=0):
    key = (m.rel, var, prefix)
    if key in seenr or depth > 6: return
    seenr.add(key)
    pre0, odeps = rprefix(m, var)
    prefix = prefix + pre0; deps = deps + ' ' + odeps
    for r in routes_of(m):
        if r['router'] != var: continue
        marks, reach = analyze(m, r['fn'])
        txt = deps + ' ' + r['deps']
        auth = 'qstash-sig' if re.search(r'verify_qstash_sig|Receiver', txt) or 'sig' in marks else 'service-role' if re.search(r'require_service_role|require_user_or_service', txt) or 'svc' in marks else 'none' if re.search(r'PUBLIC_ROUTE|mark_route_public', txt) else 'unknown'
        routes.append(dict(file=m.rel, line=r['fn'].lineno, fn=r['fn'].name, method=r['method'], path=prefix + r['path'], auth=auth, marks=sorted(marks), reach=sorted(reach)))
    for parent, child, call in m.mounts:
        if parent != var: continue
        sub = next((k.value.value for k in call.keywords if k.arg == 'prefix' and isinstance(k.value, ast.Constant)), '')
        sdeps = ' '.join(authtext(m, k.value) for k in call.keywords if k.arg == 'dependencies')
        if isinstance(child, ast.Name):
            if child.id in m.routers: mount(m, child.id, prefix + sub, deps + ' ' + sdeps, depth + 1); continue
            r = lookup(m, child.id)
            if r and r[0] == 'const':
                mount(r[1], next((k for k, v in r[1].consts.items() if v is r[2]), child.id), prefix + sub, deps + ' ' + sdeps, depth + 1)
            elif r and r[0] == 'mod' and r[1] is not None and 'router' in r[1].routers:
                mount(r[1], 'router', prefix + sub, deps + ' ' + sdeps, depth + 1)
        elif isinstance(child, ast.Attribute) and isinstance(child.value, ast.Name):
            r = lookup(m, child.value.id)
            if r and r[0] == 'mod' and r[1] is not None: mount(r[1], child.attr, prefix + sub, deps + ' ' + sdeps, depth + 1)

for am in appmods:
    for k, v in am.consts.items():
        if isinstance(v, ast.Call) and cname(v) == 'FastAPI':
            am.routers[k] = v
            mount(am, k, '', '')

# cron handlers: marks + reach
for c in crons:
    h = c['kw'].get('handler')
    m = mod(os.path.join(root, c['file']))
    if isinstance(h, str) and h in m.funcs:
        marks, reach = analyze(m, m.funcs[h])
        c['marks'] = sorted(marks); c['reach'] = sorted(reach); c['hline'] = m.funcs[h].lineno
for l in lambdas:
    m = mod(os.path.join(root, l['file']))
    if l['fn'] not in m.funcs: l['marks'] = []; l['reach'] = []; continue
    marks, reach = analyze(m, m.funcs[l['fn']])
    l['marks'] = sorted(marks); l['reach'] = sorted(reach)

envs = {}
for x in pubs:
    if x['call'] in ('send_message', 'send_message_batch'):
        t = mod(os.path.join(root, x['file'])).text
        envs[x['file']] = sorted({a or b for a, b in ENVQ.findall(t)})

json.dump(dict(pubs=pubs, crons=crons, routes=routes, lambdas=lambdas, envs=envs, parsed=len(cache)), sys.stdout)
sys.stdout.flush()
os._exit(0)
`;

// null = python3 missing or failed: caller falls back to the regex pass.
export async function runPyScan(repo: string, ignore: string[], overrides?: Record<string, string | null>): Promise<PyOut | null> {
  let ovFile = "";
  if (overrides && Object.keys(overrides).length) {
    ovFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lambda-q-")), "ov.json");
    fs.writeFileSync(ovFile, JSON.stringify(overrides));
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile("python3", ["-I", "-c", SCRIPT, repo, JSON.stringify(ignore), ovFile], { maxBuffer: 64 << 20, timeout: 120_000 }, (e, out) =>
        e ? reject(e) : resolve(out),
      ),
    );
    return JSON.parse(stdout) as PyOut;
  } catch {
    return null;
  } finally {
    if (ovFile) fs.rmSync(path.dirname(ovFile), { recursive: true, force: true });
  }
}
