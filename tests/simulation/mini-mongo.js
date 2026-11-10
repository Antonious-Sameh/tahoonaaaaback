/* eslint-disable */
// A tiny in-memory imitation of the MongoDB features the code under test uses:
// aggregation pipelines (a subset), snapshot-isolated transactions with
// write-write conflict detection, unique indexes and ObjectId strictness.
// It is a SIMULATION — see the final report for what it does/doesn't prove.
let oidCounter = 0;
export class ObjectId {
  constructor(v) { this.hex = v ? String(v).toLowerCase() : (++oidCounter).toString(16).padStart(24, '0'); }
  toString() { return this.hex; }
  toJSON() { return this.hex; }
  equals(o) { return String(o) === this.hex; }
}
const HEX = /^[0-9a-f]{24}$/i;
const castId = (v) => (typeof v === 'string' && HEX.test(v) ? new ObjectId(v) : v); // mongoose casts in find/update, NOT in aggregate
const norm = (v) => {
  if (v instanceof ObjectId) return 'O:' + v.hex;
  if (v instanceof Date) return 'D:' + v.getTime();
  if (v === undefined || v === null) return 'N:';
  return typeof v + ':' + v;
};
const clone = (v) => {
  if (v instanceof ObjectId || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
};
export const getPath = (obj, path) => {
  const parts = path.split('.');
  const go = (cur, i) => {
    if (i === parts.length) return cur;
    if (Array.isArray(cur)) return cur.map((x) => go(x, i)).flat();
    if (cur === null || cur === undefined || typeof cur !== 'object' || cur instanceof ObjectId || cur instanceof Date) return undefined;
    return go(cur[parts[i]], i + 1);
  };
  return go(obj, 0);
};
const setPath = (obj, path, val) => {
  const parts = path.split('.'); let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) { if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = val;
};
const delPath = (obj, path) => {
  const parts = path.split('.'); let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) { cur = cur?.[parts[i]]; if (!cur) return; }
  delete cur[parts[parts.length - 1]];
};
const num = (x) => (typeof x === 'number' && !Number.isNaN(x) ? x : 0);

function ev(e, doc, vars = {}) {
  if (typeof e === 'string') {
    if (e.startsWith('$$')) { const [name, ...rest] = e.slice(2).split('.'); const base = vars[name]; return rest.length ? getPath(base, rest.join('.')) : base; }
    if (e.startsWith('$')) return getPath(doc, e.slice(1));
    return e;
  }
  if (Array.isArray(e)) return e.map((x) => ev(x, doc, vars));
  if (e === null || typeof e !== 'object' || e instanceof ObjectId || e instanceof Date) return e;
  const keys = Object.keys(e);
  if (keys.length === 1 && keys[0].startsWith('$')) {
    const op = keys[0]; const a = e[op];
    switch (op) {
      case '$sum': { const v = Array.isArray(a) ? a.map((x) => ev(x, doc, vars)) : ev(a, doc, vars); return Array.isArray(v) ? v.flat().reduce((s, x) => s + num(x), 0) : num(v); }
      case '$add': return a.map((x) => ev(x, doc, vars)).reduce((s, x) => s + num(x), 0);
      case '$subtract': return num(ev(a[0], doc, vars)) - num(ev(a[1], doc, vars));
      case '$multiply': return a.map((x) => ev(x, doc, vars)).reduce((s, x) => s * num(x), 1);
      case '$ifNull': { const v = ev(a[0], doc, vars); return v === undefined || v === null ? ev(a[1], doc, vars) : v; }
      case '$eq': return norm(ev(a[0], doc, vars)) === norm(ev(a[1], doc, vars));
      case '$gt': return ev(a[0], doc, vars) > ev(a[1], doc, vars);
      case '$lt': return ev(a[0], doc, vars) < ev(a[1], doc, vars);
      case '$and': return a.every((x) => ev(x, doc, vars));
      case '$size': return ev(a, doc, vars).length;
      case '$max': { const v = (Array.isArray(a) ? a.map((x) => ev(x, doc, vars)) : [ev(a, doc, vars)]).flat().filter((x) => x !== undefined && x !== null); return v.length ? v.reduce((m, x) => (x > m ? x : m)) : null; }
      case '$cond': { const [c, t, f] = Array.isArray(a) ? a : [a.if, a.then, a.else]; return ev(c, doc, vars) ? ev(t, doc, vars) : ev(f, doc, vars); }
      case '$filter': { const as = a.as || 'this'; return (ev(a.input, doc, vars) || []).filter((x) => ev(a.cond, doc, { ...vars, [as]: x })); }
      case '$map': { const as = a.as || 'this'; return (ev(a.input, doc, vars) || []).map((x) => ev(a.in, doc, { ...vars, [as]: x })); }
      default: throw new Error(`mini-mongo: unsupported operator ${op}`);
    }
  }
  const o = {}; for (const k of keys) o[k] = ev(e[k], doc, vars); return o;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return norm(getPath(doc, k)) === norm(cond);
  });
}

export class FakeModel {
  constructor(db, name) { this.db = db; this.name = name; this.collection = { name: `${name.toLowerCase()}s` }; this.unique = []; }
  rows(session) { return session ? session.view[this.name] : this.db.live[this.name]; }
  _q(fn) { const q = { _s: null, session(s) { this._s = s; return this; }, select() { return this; }, lean() { return this; }, then(res, rej) { return Promise.resolve().then(() => fn(this._s)).then(res, rej); } }; return q; }
  aggregate(pipeline) { return this._q((s) => this.db.runPipeline(this.rows(s), pipeline, s)); }
  findById(id) { return this._q((s) => { const d = this.rows(s).find((r) => norm(r._id) === norm(castId(id))); return d ? this._wrap(d) : null; }); }
  findOne(filter) { return this._q((s) => { const d = this.rows(s).find((r) => matches(r, this._cast(filter))); return d ? this._wrap(d) : null; }); }
  exists(filter) { return this._q((s) => (this.rows(s).some((r) => matches(r, this._cast(filter))) ? { _id: 1 } : null)); }
  countDocuments(filter) { return this._q((s) => this.rows(s).filter((r) => matches(r, this._cast(filter))).length); }
  find(filter) {
    const st = { sort: null, skip: 0, limit: Infinity };
    const q = this._q((s) => { let r = this.rows(s).filter((x) => matches(x, this._cast(filter))).map(clone); if (st.sort) { const [[k, d]] = Object.entries(st.sort); r.sort((a, b) => (a[k] > b[k] ? d : a[k] < b[k] ? -d : 0)); } return r.slice(st.skip, st.skip + st.limit); });
    q.sort = (x) => { st.sort = x; return q; }; q.skip = (n) => { st.skip = n; return q; }; q.limit = (n) => { st.limit = n; return q; };
    return q;
  }
  _cast(f) { const o = {}; for (const [k, v] of Object.entries(f)) o[k] = k === '$or' ? v.map((x) => this._cast(x)) : (k.endsWith('Id') || k === '_id' ? castId(v) : v); return o; }
  _wrap(d) { return clone(d); }
  _track(session, doc) { if (!session) return; const key = `${this.name}:${doc._wk || doc._id.hex}`; if (!session.written.has(key)) session.written.set(key, doc._v || 0); }
  _checkUnique(doc, rows) {
    for (const f of this.unique) { if (doc[f] === null || doc[f] === undefined) continue; if (rows.some((r) => r[f] === doc[f])) { const e = new Error(`E11000 duplicate key ${this.name}.${f}`); e.code = 11000; throw e; } }
  }
  async create(docs, { session } = {}) {
    const out = [];
    for (const d of docs) {
      const doc = { _id: new ObjectId(), createdAt: new Date(), updatedAt: new Date(), ...clone(d), _v: 0 };
      this._checkUnique(doc, this.rows(session));
      if (session) { session.written.set(`${this.name}:${doc._id.hex}`, 0); session.inserted.push([this.name, doc]); }
      this.rows(session).push(doc); out.push(clone(doc));
    }
    return out;
  }
  async updateOne(filter, update, { session } = {}) {
    const d = this.rows(session).find((r) => matches(r, this._cast(filter)));
    if (!d) return { matchedCount: 0, modifiedCount: 0 };
    this._track(session, d);
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(d, k, v);
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async deleteOne(filter) { const rows = this.rows(null); const i = rows.findIndex((r) => matches(r, this._cast(filter))); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }
  async findOneAndUpdate(filter, update, { upsert, session } = {}) { // Counter only
    let d = this.rows(session).find((r) => matches(r, filter));
    if (!d) { if (!upsert) return null; d = { _id: new ObjectId(), ...filter, value: 0, _v: 0, _wk: `name:${filter.name}` }; this.rows(session).push(d); if (session) session.inserted.push([this.name, d]); }
    this._track(session, d);
    d.value += update.$inc.value;
    return clone(d);
  }
}

class FakeSession {
  constructor(db) { this.db = db; }
  async withTransaction(fn) {
    this.view = clone(this.db.live); this.written = new Map(); this.inserted = [];
    if (this.db.beforeCommit) await this.db.beforeCommit();
    await fn(this);
    // commit: snapshot-isolation write-write conflict detection
    for (const [key, baseV] of this.written) {
      const [name, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const liveDoc = this.db.live[name].find((r) => (r._wk || r._id.hex) === id);
      if (liveDoc && (liveDoc._v || 0) !== baseV) { const e = new Error('WriteConflict'); e.hasErrorLabel = (l) => l === 'TransientTransactionError'; this.db.conflicts += 1; throw e; }
    }
    // unique indexes must also hold against what was committed meanwhile
    for (const [name, doc] of this.inserted) { const m = this.db.models[name]; const others = this.db.live[name].filter((r) => r._id.hex !== doc._id.hex); try { m._checkUnique(doc, others); } catch (err) { err.hasErrorLabel = (l) => l === 'TransientTransactionError'; throw err; } }
    for (const [key] of this.written) {
      const name = key.slice(0, key.indexOf(':')); const id = key.slice(key.indexOf(':') + 1);
      const v = this.view[name].find((r) => (r._wk || r._id.hex) === id);
      const idx = this.db.live[name].findIndex((r) => (r._wk || r._id.hex) === id);
      const next = { ...clone(v), _v: (v._v || 0) + 1 };
      if (idx >= 0) this.db.live[name][idx] = next; else this.db.live[name].push(next);
    }
    this.db.commits += 1;
  }
  async endSession() {}
}

class FakeDb {
  constructor() { this.live = {}; this.models = {}; this.commits = 0; this.conflicts = 0; this.beforeCommit = null; }
  model(name) { if (!this.models[name]) { this.live[name] = []; this.models[name] = new FakeModel(this, name); } return this.models[name]; }
  newSession() { return new FakeSession(this); }
  byCollection(coll) { return Object.values(this.models).find((m) => m.collection.name === coll); }
  async runPipeline(rows, pipeline, session) {
    let docs = rows.map(clone);
    for (const stage of pipeline) {
      const [op] = Object.keys(stage); const a = stage[op];
      if (op === '$match') docs = docs.filter((d) => matches(d, a));
      else if (op === '$group') { const sums = {}; const out = { _id: null }; for (const d of docs) for (const [f, spec] of Object.entries(a)) { if (f === '_id') continue; const [[agg, expr]] = Object.entries(spec); const v = ev(expr, d); if (agg === '$sum') sums[f] = (sums[f] || 0) + num(v); else if (agg === '$max') sums[f] = sums[f] === undefined || v > sums[f] ? v : sums[f]; else throw new Error(`group ${agg}`); } if (!docs.length) docs = []; else { Object.assign(out, sums); docs = [out]; } }
      else if (op === '$lookup') { const other = this.byCollection(a.from); const orows = other.rows(session); docs = docs.map((d) => ({ ...d, [a.as]: orows.filter((r) => norm(getPath(r, a.foreignField)) === norm(getPath(d, a.localField))).map(clone) })); }
      else if (op === '$addFields') docs = docs.map((d) => { const o = d; const computed = Object.entries(a).map(([k, e]) => [k, ev(e, d)]); for (const [k, v] of computed) setPath(o, k, v); return o; });
      else if (op === '$project') docs = docs.map((d) => { for (const [k, v] of Object.entries(a)) { if (v !== 0) throw new Error('only exclusion $project supported'); delPath(d, k); } return d; });
      else if (op === '$sort') { const [[k, dir]] = Object.entries(a); docs.sort((x, y) => (getPath(x, k) > getPath(y, k) ? dir : getPath(x, k) < getPath(y, k) ? -dir : 0)); }
      else if (op === '$skip') docs = docs.slice(a);
      else if (op === '$limit') docs = docs.slice(0, a);
      else if (op === '$count') docs = docs.length ? [{ [a]: docs.length }] : [];
      else if (op === '$facet') { const o = {}; for (const [k, sub] of Object.entries(a)) o[k] = await this.runPipeline(docs, sub, session); docs = [o]; }
      else throw new Error(`mini-mongo: unsupported stage ${op}`);
    }
    return docs;
  }
}
let db = new FakeDb();
export const getFakeDb = () => db;
export const resetFakeDb = () => { for (const k of Object.keys(db.live)) db.live[k] = []; db.commits = 0; db.conflicts = 0; db.beforeCommit = null; };
export const unwrap = clone;
