const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const db = new Database(path.join(process.env.POS_DATA_DIR || '.', 'shop.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  gender TEXT, form TEXT, unit TEXT DEFAULT 'piece', cost REAL DEFAULT 0, price REAL DEFAULT 0,
  stock REAL DEFAULT 0, threshold REAL DEFAULT 5, supplier_id INTEGER);
CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY, product_id INTEGER, supplier_id INTEGER, qty REAL, cost REAL,
  date TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, date TEXT DEFAULT (datetime('now','localtime')),
  total REAL, discount REAL, paid REAL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS adjustments(id INTEGER PRIMARY KEY, product_id INTEGER, qty REAL, reason TEXT, user TEXT,
  date TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY, sale_id INTEGER, product_id INTEGER,
  qty REAL, price REAL, discount REAL, cost REAL);
`);

try { db.exec('ALTER TABLE sales ADD COLUMN cashier TEXT'); } catch (e) {}

try { db.exec('ALTER TABLE products ADD COLUMN active INTEGER DEFAULT 1'); } catch (e) {}
db.exec(`
CREATE TABLE IF NOT EXISTS refunds(id INTEGER PRIMARY KEY, sale_id INTEGER, date TEXT DEFAULT (datetime('now','localtime')), total REAL, user TEXT);
CREATE TABLE IF NOT EXISTS refund_items(id INTEGER PRIMARY KEY, refund_id INTEGER, sale_item_id INTEGER, product_id INTEGER, qty REAL, amount REAL, cost REAL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);
// pieces must be whole numbers; meters may have decimals
const checkQty = (unit, qty) => {
  if (!(qty > 0)) throw new Error('Quantity must be more than 0');
  if (unit !== 'meter' && !Number.isInteger(qty)) throw new Error('Pieces must be a whole number (1, 2, 10...)');
};


// date-range filter used by the history tabs (blank = last 30 days)
const W = col => `date(${col}) >= COALESCE(?, date('now','localtime','-29 days')) AND date(${col}) <= COALESCE(?, date('now','localtime'))`;
const range = r => [r.query.from || null, r.query.to || null];

// ---- backups ----
const fs = require('fs');
const dataDir = process.env.POS_DATA_DIR || '.';
const getSet = k => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
const setSet = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
const localBackupDir = path.join(dataDir, 'backups');
function prune(dir) { // keep everything from the 2 newest days, then 1 file per day for 60 days
  const files = fs.readdirSync(dir).filter(f => /^shop-\d{4}-\d\d-\d\d_\d\d-\d\d\.db$/.test(f)).sort().reverse();
  const days = [...new Set(files.map(f => f.slice(5, 15)))], recent = new Set(days.slice(0, 2)), seen = new Set();
  files.forEach(f => { const day = f.slice(5, 15); if (recent.has(day)) return;
    if (seen.has(day) || days.indexOf(day) > 60) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
    seen.add(day); });
}
async function runBackup() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const dirs = [localBackupDir]; const cloud = getSet('backup_dir'); if (cloud) dirs.push(cloud);
  const out = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `shop-${stamp}.db`);
      try { fs.unlinkSync(f); } catch (e) {}
      await db.backup(f); prune(dir); out.push(dir + ' - OK');
    } catch (e) { out.push(dir + ' - FAILED: ' + e.message); }
  }
  const msg = new Date().toLocaleString() + ' | ' + out.join(' ; ');
  setSet('last_backup', msg); return { last: msg };
}


// ---- auth ----
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [salt, h] = stored.split(':'); const x = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); };
if (!db.prepare('SELECT 1 FROM users').get())
  db.prepare('INSERT INTO users(username,hash,role) VALUES(?,?,?)').run('admin', hashPw('admin123'), 'admin');
const sessions = new Map();

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  const u = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u; next();
});
// adminOnly defaults to true; pass false for routes a cashier may use
// Turns technical database errors into messages the user can understand
const friendly = e => {
  const m = e.message || '';
  if (m.includes('UNIQUE') && m.includes('products.code'))
    return 'An item with this code already exists. Please enter a different item code.';
  if (m.includes('UNIQUE') && m.includes('users.username'))
    return 'This username is already taken. Please choose a different username.';
  if (m.includes('UNIQUE')) return 'This record already exists.';
  if (m.includes('NOT NULL')) return 'Please fill in all the required fields.';
  return m;
};
const A = (m, p, f, adminOnly = true) => app[m]('/api' + p, (req, res) => {
  if (adminOnly && req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try { Promise.resolve(f(req)).then(j => res.json(j)).catch(e => res.status(400).json({ error: friendly(e) })); }
  catch (e) { res.status(400).json({ error: friendly(e) }); }
});

A('post', '/login', r => {
  const { username, password } = r.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !checkPw(password || '', u.hash)) throw new Error('Wrong username or password');
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { id: u.id, username: u.username, role: u.role });
  return { token, role: u.role, username: u.username, defaultPw: u.role === 'admin' && password === 'admin123' };
}, false);
A('post', '/logout', r => { sessions.delete((r.headers.authorization || '').replace('Bearer ', '')); return { ok: true }; }, false);
A('post', '/change-username', r => {
  const name = (r.body.username || '').trim();
  if (name.length < 3) throw new Error('Username must be at least 3 characters');
  db.prepare('UPDATE users SET username=? WHERE id=?').run(name, r.user.id);
  r.user.username = name;
  return { username: name };
});
A('post', '/change-password', r => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.user.id);
  if (!checkPw(r.body.old || '', u.hash)) throw new Error('Old password is wrong');
  if ((r.body.new || '').length < 6) throw new Error('New password must be at least 6 characters');
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(hashPw(r.body.new), u.id); return { ok: true };
}, false);
A('get', '/users', () => db.prepare('SELECT id,username,role FROM users ORDER BY role,username').all());
A('post', '/users', r => {
  const { username, password } = r.body;
  if (!username || (password || '').length < 6) throw new Error('Username required, password min 6 characters');
  db.prepare('INSERT INTO users(username,hash,role) VALUES(?,?,?)').run(username.trim(), hashPw(password), 'cashier');
  return { ok: true };
});
A('put', '/users/:id/password', r => {
  if ((r.body.password || '').length < 6) throw new Error('Password min 6 characters');
  db.prepare("UPDATE users SET hash=? WHERE id=? AND role='cashier'").run(hashPw(r.body.password), r.params.id);
  for (const [t, u] of sessions) if (u.id == r.params.id) sessions.delete(t);
  return { ok: true };
});
A('delete', '/users/:id', r => {
  db.prepare("DELETE FROM users WHERE id=? AND role='cashier'").run(r.params.id);
  for (const [t, u] of sessions) if (u.id == r.params.id) sessions.delete(t);
  return { ok: true };
});
A('post', '/stock-adjust', r => db.transaction(() => {
  const { product_id, qty, reason } = r.body;
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!p) throw new Error('Product not found');
  checkQty(p.unit, qty);
  if (qty > p.stock) throw new Error(`Only ${p.stock} in stock`);
  db.prepare('UPDATE products SET stock = stock - ? WHERE id=?').run(qty, product_id);
  db.prepare('INSERT INTO adjustments(product_id,qty,reason,user) VALUES(?,?,?,?)').run(product_id, qty, reason || '', r.user.username);
  return { ok: true };
})());

A('get', '/suppliers', () => db.prepare('SELECT * FROM suppliers ORDER BY name').all());
A('post', '/suppliers', r => {
  const { name, phone, address } = r.body;
  return { id: db.prepare('INSERT INTO suppliers(name,phone,address) VALUES(?,?,?)').run(name, phone, address).lastInsertRowid };
});

A('get', '/products', r => {
  const rows = db.prepare(`SELECT p.*, s.name supplier, s.phone supplier_phone FROM products p
   LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.active=1 ORDER BY p.name`).all();
  if (r.user.role === 'admin') return rows;
  return rows.map(p => ({ id: p.id, code: p.code, name: p.name, gender: p.gender, form: p.form, unit: p.unit, price: p.price, stock: p.stock }));
}, false);
A('post', '/products', r => {
  const b = r.body;
  return { id: db.prepare(`INSERT INTO products(code,name,gender,form,unit,cost,price,threshold,supplier_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(b.code, b.name, b.gender, b.form, b.unit, b.cost, b.price, b.threshold, b.supplier_id || null).lastInsertRowid };
});
A('put', '/products/:id', r => {
  const b = r.body;
  db.prepare(`UPDATE products SET name=?,gender=?,form=?,unit=?,cost=?,price=?,threshold=?,supplier_id=? WHERE id=?`)
    .run(b.name, b.gender, b.form, b.unit, b.cost, b.price, b.threshold, b.supplier_id || null, r.params.id);
  return { ok: true };
});

// Stock in: adds stock, updates cost as weighted average
A('post', '/purchases', r => db.transaction(() => {
  const { product_id, supplier_id, qty, cost } = r.body;
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!p) throw new Error('Product not found');
  checkQty(p.unit, qty);
  const newStock = p.stock + qty;
  const avg = newStock > 0 ? (Math.max(p.stock, 0) * p.cost + qty * cost) / (Math.max(p.stock, 0) + qty) : cost;
  db.prepare('INSERT INTO purchases(product_id,supplier_id,qty,cost) VALUES(?,?,?,?)').run(product_id, supplier_id || p.supplier_id, qty, cost);
  db.prepare('UPDATE products SET stock=?, cost=?, supplier_id=COALESCE(?,supplier_id) WHERE id=?').run(newStock, avg, supplier_id || null, product_id);
  return { ok: true };
})());

// Sale: transaction so two counters can't oversell
A('post', '/sales', r => db.transaction(() => {
  const { items, paid } = r.body;
  if (!items || !items.length) throw new Error('Empty bill');
  let total = 0, discount = 0;
  const sid = db.prepare('INSERT INTO sales(total,discount,paid,cashier) VALUES(0,0,?,?)').run(paid || 0, r.user.username).lastInsertRowid;
  for (const it of items) {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id);
    if (!p) throw new Error('Product not found');
    checkQty(p.unit, it.qty);
    if (p.stock < it.qty) throw new Error(`Not enough stock for ${p.name} (have ${p.stock})`);
    const d = it.discount || 0;
    if (d < 0 || d > it.qty * p.price) throw new Error('Invalid discount for ' + p.name);
    total += it.qty * p.price - d; discount += d;
    db.prepare('INSERT INTO sale_items(sale_id,product_id,qty,price,discount,cost) VALUES(?,?,?,?,?,?)')
      .run(sid, p.id, it.qty, p.price, d, p.cost);
    db.prepare('UPDATE products SET stock = stock - ? WHERE id=?').run(it.qty, p.id);
  }
  if (Math.round((paid || 0) * 100) < Math.round(total * 100)) throw new Error(`Paid amount (${paid || 0}) is less than the bill total (${total.toFixed(2)})`);
  db.prepare('UPDATE sales SET total=?, discount=? WHERE id=?').run(total, discount, sid);
  return { id: sid, total, discount };
})(), false);

A('delete', '/products/:id', r => {
  const id = r.params.id;
  const n = db.prepare(`SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id=?)+(SELECT COUNT(*) FROM purchases WHERE product_id=?)
    +(SELECT COUNT(*) FROM adjustments WHERE product_id=?) n`).get(id, id, id).n;
  if (!n) { db.prepare('DELETE FROM products WHERE id=?').run(id); return { archived: false }; }
  db.prepare("UPDATE products SET active=0, code=code||'#del'||id WHERE id=?").run(id); // keep history
  return { archived: true };
});
A('put', '/suppliers/:id', r => {
  const { name, phone, address } = r.body;
  db.prepare('UPDATE suppliers SET name=?,phone=?,address=? WHERE id=?').run(name, phone, address, r.params.id); return { ok: true };
});
A('delete', '/suppliers/:id', r => {
  db.prepare('UPDATE products SET supplier_id=NULL WHERE supplier_id=?').run(r.params.id);
  db.prepare('DELETE FROM suppliers WHERE id=?').run(r.params.id); return { ok: true };
});
A('get', '/shop', () => ({ name: (db.prepare("SELECT value FROM settings WHERE key='shop'").get() || {}).value || 'Insaf Cloth House' }), false);
A('put', '/shop', r => {
  db.prepare("INSERT INTO settings(key,value) VALUES('shop',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run((r.body.name || '').trim() || 'Insaf Cloth House'); return { ok: true };
});
A('get', '/sales/:id', r => {
  const s = db.prepare('SELECT * FROM sales WHERE id=?').get(r.params.id);
  if (!s) throw new Error('Bill not found');
  s.items = db.prepare(`SELECT si.id,si.product_id,si.qty,si.price,si.discount,p.code,p.name,p.unit,
    COALESCE((SELECT SUM(qty) FROM refund_items WHERE sale_item_id=si.id),0) refunded
    FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=?`).all(s.id);
  return s;
}, false);
A('post', '/refunds', r => db.transaction(() => {
  const { sale_id, items } = r.body;
  if (!db.prepare('SELECT 1 FROM sales WHERE id=?').get(sale_id)) throw new Error('Bill not found');
  const fid = db.prepare('INSERT INTO refunds(sale_id,total,user) VALUES(?,0,?)').run(sale_id, r.user.username).lastInsertRowid;
  let total = 0, n = 0;
  for (const it of items || []) {
    if (!(it.qty > 0)) continue;
    const si = db.prepare('SELECT si.*, p.unit FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.id=? AND si.sale_id=?').get(it.sale_item_id, sale_id);
    if (!si) throw new Error('Item is not on this bill');
    checkQty(si.unit, it.qty);
    const done = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM refund_items WHERE sale_item_id=?').get(si.id).q;
    if (it.qty > si.qty - done + 1e-9) throw new Error('Cannot refund more than was sold');
    const amount = +(((si.qty * si.price - si.discount) / si.qty) * it.qty).toFixed(2);
    db.prepare('INSERT INTO refund_items(refund_id,sale_item_id,product_id,qty,amount,cost) VALUES(?,?,?,?,?,?)').run(fid, si.id, si.product_id, it.qty, amount, si.cost);
    db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(it.qty, si.product_id);
    total += amount; n++;
  }
  if (!n) throw new Error('Select at least one item to refund');
  db.prepare('UPDATE refunds SET total=? WHERE id=?').run(total, fid);
  return { id: fid, total };
})(), false);

A('get', '/backup', () => ({ dir: getSet('backup_dir') || '', local: localBackupDir, last: getSet('last_backup') || '' }));
A('put', '/backup', async r => {
  const dir = (r.body.dir || '').trim();
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); }
             catch (e) { throw new Error('Cannot use that folder: ' + e.message); } }
  setSet('backup_dir', dir); return runBackup();
});
A('post', '/backup/run', () => runBackup());

A('get', '/low-stock', () => db.prepare(
  `SELECT p.code,p.name,p.stock,p.unit,p.threshold,s.name supplier,s.phone supplier_phone
   FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.active=1 AND p.stock <= p.threshold ORDER BY p.stock`).all());

A('get', '/report', r => {
  const start = r.query.period === 'month' ? "date('now','localtime','start of month')" : "date('now','localtime','-6 days')";
  const q = db.prepare(`SELECT COALESCE(SUM(si.qty*si.price - si.discount),0) revenue,
      COALESCE(SUM(si.qty*si.cost),0) cogs, COALESCE(SUM(si.discount),0) discounts
    FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.date) >= ${start}`).get();
  const f = db.prepare(`SELECT COALESCE(SUM(ri.amount),0) amount, COALESCE(SUM(ri.qty*ri.cost),0) cost
    FROM refund_items ri JOIN refunds f ON f.id=ri.refund_id WHERE date(f.date) >= ${start}`).get();
  q.refunds = f.amount; q.revenue -= f.amount; q.cogs -= f.cost; q.profit = q.revenue - q.cogs;
  q.top = db.prepare(`SELECT p.name, SUM(si.qty) qty FROM sale_items si JOIN sales s ON s.id=si.sale_id
    JOIN products p ON p.id=si.product_id WHERE date(s.date) >= ${start} GROUP BY p.id ORDER BY qty DESC LIMIT 5`).all();
  return q;
});

A('get', '/report/purchases', r => db.prepare(
  `SELECT date(pu.date) day, p.name item, pu.qty, p.unit, pu.cost, ROUND(pu.qty*pu.cost,2) amount, s.name supplier
   FROM purchases pu JOIN products p ON p.id=pu.product_id LEFT JOIN suppliers s ON s.id=pu.supplier_id
   WHERE ${W('pu.date')} ORDER BY pu.date DESC`).all(...range(r)));

A('get', '/report/daily', r => {
  const a = range(r);
  const s = db.prepare(`SELECT date(s.date) day, COUNT(DISTINCT s.id) bills, ROUND(SUM(si.qty*si.price - si.discount),2) sales,
    ROUND(SUM(si.qty*si.cost),2) cost FROM sales s JOIN sale_items si ON si.sale_id=s.id
    WHERE ${W('s.date')} GROUP BY date(s.date)`).all(...a);
  const f = db.prepare(`SELECT date(f.date) day, ROUND(SUM(ri.amount),2) refunds, ROUND(SUM(ri.qty*ri.cost),2) cost
    FROM refunds f JOIN refund_items ri ON ri.refund_id=f.id WHERE ${W('f.date')} GROUP BY date(f.date)`).all(...a);
  const m = {};
  s.forEach(x => m[x.day] = { day: x.day, bills: x.bills, sales: x.sales, refunds: 0, cost: x.cost });
  f.forEach(x => { m[x.day] = m[x.day] || { day: x.day, bills: 0, sales: 0, refunds: 0, cost: 0 };
    m[x.day].refunds = x.refunds; m[x.day].cost = +(m[x.day].cost - x.cost).toFixed(2); });
  return Object.values(m).sort((a, b) => b.day.localeCompare(a.day)).map(x => ({ ...x, net: +(x.sales - x.refunds).toFixed(2) }));
});
A('get', '/report/refunds', r => db.prepare(
  `SELECT date(f.date) day, f.sale_id bill, p.name item, ri.qty, p.unit, ri.amount, f.user
   FROM refunds f JOIN refund_items ri ON ri.refund_id=f.id JOIN products p ON p.id=ri.product_id
   WHERE ${W('f.date')} ORDER BY f.date DESC`).all(...range(r)));

setTimeout(() => runBackup().catch(() => {}), 30000);
setInterval(() => runBackup().catch(() => {}), 3 * 3600 * 1000);
const server = app.listen(3000, '0.0.0.0', () => console.log('POS running on http://localhost:3000 (other PCs: http://<this-pc-ip>:3000)'));
module.exports = server;
