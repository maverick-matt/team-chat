const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const JWT_SECRET = process.env.JWT_SECRET || 'maverick-secret';
const PORT = process.env.PORT || 3000;
const db = new Database(process.env.DB_PATH || '/data/chat.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    avatar_color TEXT DEFAULT '#F59E0B',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius INTEGER DEFAULT 300
  );
  CREATE TABLE IF NOT EXISTS user_stores (
    user_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, store_id)
  );
  CREATE TABLE IF NOT EXISTS clock_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    clock_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    clock_out_at DATETIME,
    clock_in_lat REAL,
    clock_in_lng REAL,
    clock_out_lat REAL,
    clock_out_lng REAL,
    notes TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS rosters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    store_id INTEGER,
    week_start DATE NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS roster_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roster_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    store_id INTEGER NOT NULL,
    shift_date DATE NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    role TEXT DEFAULT '',
    notes TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    fields TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS form_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS kb_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon TEXT DEFAULT '📄',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS kb_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS kb_article_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(article_id, user_id)
  );
`);

// Seed admin user
if (!db.prepare('SELECT id FROM users WHERE role = ?').get('admin')) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, name, password_hash, role, avatar_color) VALUES (?,?,?,?,?)').run('admin','Admin',hash,'admin','#EF4444');
  console.log('Default admin: admin / admin123');
}

// Seed channels
if (!db.prepare('SELECT id FROM channels WHERE name = ?').get('general')) {
  db.prepare('INSERT INTO channels (name,description) VALUES (?,?)').run('general','General team discussion');
  db.prepare('INSERT INTO channels (name,description) VALUES (?,?)').run('announcements','Important announcements');
  db.prepare('INSERT INTO channels (name,description) VALUES (?,?)').run('random','Off-topic chat');
}

// Seed Maverick Campers store locations
if (!db.prepare('SELECT id FROM stores LIMIT 1').get()) {
  const stores = [
    ['Wangara WA','1 Quartz Way, Wangara WA 6065',-31.7932,115.8026,300],
    ['Prospect SA','142 Main North Rd, Prospect SA 5082',-34.8841,138.5994,300],
    ['Caboolture QLD','37B Lear Jet Drive, Caboolture QLD 4510',-27.0657,152.9453,300],
    ['Campbellfield VIC','1920 Hume Highway, Campbellfield VIC 3061',-37.6603,144.9644,300],
  ];
  stores.forEach(([name,address,lat,lng,radius]) =>
    db.prepare('INSERT INTO stores (name,address,lat,lng,radius) VALUES (?,?,?,?,?)').run(name,address,lat,lng,radius));
}

// Seed KB categories
if (!db.prepare('SELECT id FROM kb_categories LIMIT 1').get()) {
  db.prepare("INSERT INTO kb_categories (name,description,icon,sort_order) VALUES (?,?,?,?)").run('Getting Started','Onboarding & company basics','🚀',0);
  db.prepare("INSERT INTO kb_categories (name,description,icon,sort_order) VALUES (?,?,?,?)").run('Policies & Procedures','HR and company policies','📋',1);
  db.prepare("INSERT INTO kb_categories (name,description,icon,sort_order) VALUES (?,?,?,?)").run('Products','Camper trailers & caravan knowledge','🏕️',2);
  db.prepare("INSERT INTO kb_categories (name,description,icon,sort_order) VALUES (?,?,?,?)").run('Safety','Workplace health & safety','⛑️',3);
}

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req,res,next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({error:'Unauthorized'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Invalid token'}); }
};
const adminOnly = (req,res,next) => {
  if (req.user.role !== 'admin') return res.status(403).json({error:'Admin only'});
  next();
};
const managerOrAdmin = (req,res,next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') return res.status(403).json({error:'Manager or Admin only'});
  next();
};

function haversineDist(lat1,lng1,lat2,lng2) {
  const R=6371000, φ1=lat1*Math.PI/180, φ2=lat2*Math.PI/180;
  const Δφ=(lat2-lat1)*Math.PI/180, Δλ=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(Δφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ---- AUTH ----
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user||!bcrypt.compareSync(password,user.password_hash))
    return res.status(401).json({error:'Invalid username or password'});
  const token=jwt.sign({id:user.id,username:user.username,name:user.name,role:user.role},JWT_SECRET,{expiresIn:'7d'});
  res.cookie('token',token,{httpOnly:true,maxAge:7*24*60*60*1000});
  res.json({id:user.id,username:user.username,name:user.name,role:user.role,avatar_color:user.avatar_color});
});
app.post('/api/logout',(req,res)=>{res.clearCookie('token');res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>{
  res.json(db.prepare('SELECT id,username,name,role,avatar_color FROM users WHERE id=?').get(req.user.id));
});

// ---- USERS ----
const COLORS=['#F59E0B','#10B981','#3B82F6','#8B5CF6','#EC4899','#EF4444','#06B6D4','#84CC16'];
app.get('/api/users',auth,(req,res)=>{
  res.json(db.prepare('SELECT id,username,name,role,avatar_color FROM users ORDER BY name').all());
});
app.post('/api/users',auth,adminOnly,(req,res)=>{
  const {username,name,password,role}=req.body;
  if (!username||!name||!password) return res.status(400).json({error:'Missing fields'});
  const color=COLORS[Math.floor(Math.random()*COLORS.length)];
  try {
    const hash=bcrypt.hashSync(password,10);
    const r=db.prepare('INSERT INTO users (username,name,password_hash,role,avatar_color) VALUES (?,?,?,?,?)').run(username.toLowerCase().trim(),name.trim(),hash,role||'member',color);
    res.json({id:r.lastInsertRowid,username,name,role:role||'member',avatar_color:color});
  } catch { res.status(400).json({error:'Username already exists'}); }
});
app.delete('/api/users/:id',auth,adminOnly,(req,res)=>{
  const t=db.prepare('SELECT role FROM users WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({error:'Not found'});
  if (t.role==='admin') return res.status(400).json({error:'Cannot delete admin'});
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ok:true});
});
app.get('/api/users/:id/stores',auth,(req,res)=>{
  const uid=parseInt(req.params.id);
  if (req.user.role!=='admin'&&req.user.id!==uid) return res.status(403).json({error:'Forbidden'});
  res.json(db.prepare('SELECT s.* FROM stores s JOIN user_stores us ON us.store_id=s.id WHERE us.user_id=?').all(uid));
});
app.put('/api/users/:id/stores',auth,adminOnly,(req,res)=>{
  const uid=parseInt(req.params.id);
  const {store_ids}=req.body;
  db.prepare('DELETE FROM user_stores WHERE user_id=?').run(uid);
  if (Array.isArray(store_ids)) store_ids.forEach(sid=>db.prepare('INSERT OR IGNORE INTO user_stores (user_id,store_id) VALUES (?,?)').run(uid,sid));
  res.json({ok:true});
});

// ---- STORES ----
app.get('/api/stores',auth,(req,res)=>{
  res.json(db.prepare('SELECT * FROM stores ORDER BY name').all());
});
app.post('/api/stores',auth,adminOnly,(req,res)=>{
  const {name,address,lat,lng,radius}=req.body;
  if (!name||lat==null||lng==null) return res.status(400).json({error:'Missing fields'});
  const r=db.prepare('INSERT INTO stores (name,address,lat,lng,radius) VALUES (?,?,?,?,?)').run(name,address||'',lat,lng,radius||300);
  res.json({id:r.lastInsertRowid,name,address,lat,lng,radius:radius||300});
});
app.put('/api/stores/:id',auth,adminOnly,(req,res)=>{
  const {name,address,lat,lng,radius}=req.body;
  db.prepare('UPDATE stores SET name=?,address=?,lat=?,lng=?,radius=? WHERE id=?').run(name,address||'',lat,lng,radius||300,req.params.id);
  res.json({ok:true});
});
app.delete('/api/stores/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM stores WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM user_stores WHERE store_id=?').run(req.params.id);
  res.json({ok:true});
});

// ---- CLOCK ----
app.get('/api/clock/status',auth,(req,res)=>{
  const rec=db.prepare('SELECT cr.*,s.name as store_name FROM clock_records cr JOIN stores s ON s.id=cr.store_id WHERE cr.user_id=? AND cr.clock_out_at IS NULL ORDER BY cr.clock_in_at DESC LIMIT 1').get(req.user.id);
  res.json({clocked_in:!!rec,record:rec||null});
});
app.post('/api/clock/in',auth,(req,res)=>{
  const {lat,lng,store_id}=req.body;
  const active=db.prepare('SELECT id FROM clock_records WHERE user_id=? AND clock_out_at IS NULL').get(req.user.id);
  if (active) return res.status(400).json({error:'Already clocked in'});
  const store=db.prepare('SELECT * FROM stores WHERE id=?').get(store_id);
  if (!store) return res.status(404).json({error:'Store not found'});
  if (req.user.role!=='admin') {
    const assigned=db.prepare('SELECT 1 FROM user_stores WHERE user_id=? AND store_id=?').get(req.user.id,store_id);
    if (!assigned) return res.status(403).json({error:'You are not assigned to this location'});
    if (lat!=null&&lng!=null) {
      const dist=haversineDist(lat,lng,store.lat,store.lng);
      if (dist>store.radius) return res.status(400).json({error:`Too far from ${store.name}. You are ${Math.round(dist)}m away (max ${store.radius}m)`});
    }
  }
  const r=db.prepare('INSERT INTO clock_records (user_id,store_id,clock_in_lat,clock_in_lng) VALUES (?,?,?,?)').run(req.user.id,store_id,lat||null,lng||null);
  res.json({id:r.lastInsertRowid,store_name:store.name});
});
app.post('/api/clock/out',auth,(req,res)=>{
  const {lat,lng,notes}=req.body;
  const rec=db.prepare('SELECT id FROM clock_records WHERE user_id=? AND clock_out_at IS NULL').get(req.user.id);
  if (!rec) return res.status(400).json({error:'Not clocked in'});
  db.prepare('UPDATE clock_records SET clock_out_at=CURRENT_TIMESTAMP,clock_out_lat=?,clock_out_lng=?,notes=? WHERE id=?').run(lat||null,lng||null,notes||'',rec.id);
  res.json({ok:true});
});
app.get('/api/clock/records',auth,(req,res)=>{
  const uid=req.query.user_id&&req.user.role==='admin'?parseInt(req.query.user_id):req.user.id;
  res.json(db.prepare('SELECT cr.*,s.name as store_name,u.name as user_name FROM clock_records cr JOIN stores s ON s.id=cr.store_id JOIN users u ON u.id=cr.user_id WHERE cr.user_id=? ORDER BY cr.clock_in_at DESC LIMIT 50').all(uid));
});
app.get('/api/clock/all',auth,adminOnly,(req,res)=>{
  res.json(db.prepare('SELECT cr.*,s.name as store_name,u.name as user_name,u.avatar_color FROM clock_records cr JOIN stores s ON s.id=cr.store_id JOIN users u ON u.id=cr.user_id ORDER BY cr.clock_in_at DESC LIMIT 300').all());
});
app.put('/api/clock/records/:id',auth,adminOnly,(req,res)=>{
  const {clock_in_at,clock_out_at,notes}=req.body;
  db.prepare('UPDATE clock_records SET clock_in_at=?,clock_out_at=?,notes=? WHERE id=?').run(clock_in_at,clock_out_at||null,notes||'',req.params.id);
  res.json({ok:true});
});
app.delete('/api/clock/records/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM clock_records WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// ---- ROSTERS ----
app.get('/api/rosters',auth,(req,res)=>{
  res.json(db.prepare('SELECT r.*,s.name as store_name FROM rosters r LEFT JOIN stores s ON s.id=r.store_id ORDER BY r.week_start DESC').all());
});
app.post('/api/rosters',auth,adminOnly,(req,res)=>{
  const {name,store_id,week_start}=req.body;
  if (!name||!week_start) return res.status(400).json({error:'Missing fields'});
  const r=db.prepare('INSERT INTO rosters (name,store_id,week_start,created_by) VALUES (?,?,?,?)').run(name,store_id||null,week_start,req.user.id);
  res.json({id:r.lastInsertRowid,name,store_id,week_start});
});
app.delete('/api/rosters/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM roster_shifts WHERE roster_id=?').run(req.params.id);
  db.prepare('DELETE FROM rosters WHERE id=?').run(req.params.id);
  res.json({ok:true});
});
app.get('/api/rosters/:id/shifts',auth,(req,res)=>{
  res.json(db.prepare('SELECT rs.*,u.name as user_name,u.avatar_color,s.name as store_name FROM roster_shifts rs JOIN users u ON u.id=rs.user_id JOIN stores s ON s.id=rs.store_id WHERE rs.roster_id=? ORDER BY rs.shift_date,rs.start_time').all(req.params.id));
});
app.post('/api/rosters/:id/shifts',auth,adminOnly,(req,res)=>{
  const {user_id,store_id,shift_date,start_time,end_time,role,notes}=req.body;
  if (!user_id||!store_id||!shift_date||!start_time||!end_time) return res.status(400).json({error:'Missing fields'});
  const r=db.prepare('INSERT INTO roster_shifts (roster_id,user_id,store_id,shift_date,start_time,end_time,role,notes) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id,user_id,store_id,shift_date,start_time,end_time,role||'',notes||'');
  res.json({id:r.lastInsertRowid});
});
app.delete('/api/rosters/shifts/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM roster_shifts WHERE id=?').run(req.params.id);
  res.json({ok:true});
});
app.get('/api/my/shifts',auth,(req,res)=>{
  const from=req.query.from||new Date().toISOString().slice(0,10);
  res.json(db.prepare('SELECT rs.*,r.name as roster_name,s.name as store_name FROM roster_shifts rs JOIN rosters r ON r.id=rs.roster_id JOIN stores s ON s.id=rs.store_id WHERE rs.user_id=? AND rs.shift_date>=? ORDER BY rs.shift_date,rs.start_time LIMIT 30').all(req.user.id,from));
});
app.get('/api/all/shifts',auth,adminOnly,(req,res)=>{
  const from=req.query.from||new Date().toISOString().slice(0,10);
  const to=req.query.to||new Date(Date.now()+14*864e5).toISOString().slice(0,10);
  res.json(db.prepare('SELECT rs.*,u.name as user_name,u.avatar_color,s.name as store_name FROM roster_shifts rs JOIN users u ON u.id=rs.user_id JOIN stores s ON s.id=rs.store_id WHERE rs.shift_date>=? AND rs.shift_date<=? ORDER BY rs.shift_date,rs.start_time').all(from,to));
});

// ---- FORMS ----
app.get('/api/forms',auth,(req,res)=>{
  res.json(db.prepare('SELECT id,title,description,active,created_at FROM forms WHERE active=1 ORDER BY created_at DESC').all());
});
app.get('/api/forms/all',auth,managerOrAdmin,(req,res)=>{
  res.json(db.prepare('SELECT * FROM forms ORDER BY created_at DESC').all());
});
app.get('/api/forms/:id',auth,(req,res)=>{
  const f=db.prepare('SELECT * FROM forms WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({error:'Not found'});
  f.fields=JSON.parse(f.fields);
  res.json(f);
});
app.post('/api/forms',auth,managerOrAdmin,(req,res)=>{
  const {title,description,fields}=req.body;
  if (!title) return res.status(400).json({error:'Title required'});
  const r=db.prepare('INSERT INTO forms (title,description,fields,created_by) VALUES (?,?,?,?)').run(title,description||'',JSON.stringify(fields||[]),req.user.id);
  res.json({id:r.lastInsertRowid});
});
app.put('/api/forms/:id',auth,managerOrAdmin,(req,res)=>{
  const {title,description,fields,active}=req.body;
  db.prepare('UPDATE forms SET title=?,description=?,fields=?,active=? WHERE id=?').run(title,description||'',JSON.stringify(fields||[]),active??1,req.params.id);
  res.json({ok:true});
});
app.delete('/api/forms/:id',auth,managerOrAdmin,(req,res)=>{
  db.prepare('DELETE FROM forms WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM form_submissions WHERE form_id=?').run(req.params.id);
  res.json({ok:true});
});
app.post('/api/forms/:id/submit',auth,(req,res)=>{
  const {data}=req.body;
  const form=db.prepare('SELECT id FROM forms WHERE id=? AND active=1').get(req.params.id);
  if (!form) return res.status(404).json({error:'Form not found or inactive'});
  const r=db.prepare('INSERT INTO form_submissions (form_id,user_id,data) VALUES (?,?,?)').run(req.params.id,req.user.id,JSON.stringify(data||{}));
  res.json({id:r.lastInsertRowid});
});
app.get('/api/forms/:id/submissions',auth,managerOrAdmin,(req,res)=>{
  const subs=db.prepare('SELECT fs.*,u.name as user_name,u.avatar_color FROM form_submissions fs JOIN users u ON u.id=fs.user_id WHERE fs.form_id=? ORDER BY fs.submitted_at DESC').all(req.params.id);
  subs.forEach(s=>{s.data=JSON.parse(s.data)});
  res.json(subs);
});

// ---- KNOWLEDGE BASE ----
app.get('/api/kb/categories',auth,(req,res)=>{
  res.json(db.prepare('SELECT * FROM kb_categories ORDER BY sort_order,name').all());
});
app.post('/api/kb/categories',auth,managerOrAdmin,(req,res)=>{
  const {name,description,icon,sort_order}=req.body;
  if (!name) return res.status(400).json({error:'Name required'});
  const r=db.prepare('INSERT INTO kb_categories (name,description,icon,sort_order) VALUES (?,?,?,?)').run(name,description||'',icon||'📄',sort_order||0);
  res.json({id:r.lastInsertRowid});
});
app.put('/api/kb/categories/:id',auth,managerOrAdmin,(req,res)=>{
  const {name,description,icon,sort_order}=req.body;
  db.prepare('UPDATE kb_categories SET name=?,description=?,icon=?,sort_order=? WHERE id=?').run(name,description||'',icon||'📄',sort_order||0,req.params.id);
  res.json({ok:true});
});
app.delete('/api/kb/categories/:id',auth,managerOrAdmin,(req,res)=>{
  db.prepare('DELETE FROM kb_categories WHERE id=?').run(req.params.id);
  db.prepare('UPDATE kb_articles SET category_id=NULL WHERE category_id=?').run(req.params.id);
  res.json({ok:true});
});
app.get('/api/kb/articles',auth,(req,res)=>{
  const catId=req.query.category_id;
  let q='SELECT a.id,a.title,a.category_id,a.created_at,a.updated_at,c.name as category_name,c.icon as category_icon FROM kb_articles a LEFT JOIN kb_categories c ON c.id=a.category_id';
  const args=[];
  if (catId){q+=' WHERE a.category_id=?';args.push(catId);}
  q+=' ORDER BY a.updated_at DESC';
  res.json(db.prepare(q).all(...args));
});
app.get('/api/kb/articles/:id',auth,(req,res)=>{
  const a=db.prepare('SELECT a.*,c.name as category_name,c.icon as category_icon FROM kb_articles a LEFT JOIN kb_categories c ON c.id=a.category_id WHERE a.id=?').get(req.params.id);
  if (!a) return res.status(404).json({error:'Not found'});
  res.json(a);
});
app.post('/api/kb/articles',auth,managerOrAdmin,(req,res)=>{
  const {title,content,category_id}=req.body;
  if (!title) return res.status(400).json({error:'Title required'});
  const r=db.prepare('INSERT INTO kb_articles (title,content,category_id,created_by) VALUES (?,?,?,?)').run(title,content||'',category_id||null,req.user.id);
  res.json({id:r.lastInsertRowid});
});
app.put('/api/kb/articles/:id',auth,managerOrAdmin,(req,res)=>{
  const {title,content,category_id}=req.body;
  db.prepare('UPDATE kb_articles SET title=?,content=?,category_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title,content||'',category_id||null,req.params.id);
  res.json({ok:true});
});
app.delete('/api/kb/articles/:id',auth,managerOrAdmin,(req,res)=>{
  db.prepare('DELETE FROM kb_articles WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM kb_article_reads WHERE article_id=?').run(req.params.id);
  res.json({ok:true});
});
// Mark article as read
app.post('/api/kb/articles/:id/read',auth,(req,res)=>{
  db.prepare('INSERT OR REPLACE INTO kb_article_reads (article_id,user_id,read_at) VALUES (?,?,CURRENT_TIMESTAMP)').run(req.params.id,req.user.id);
  res.json({ok:true});
});
// Get read status for current user across all articles
app.get('/api/kb/reads',auth,(req,res)=>{
  res.json(db.prepare('SELECT article_id,read_at FROM kb_article_reads WHERE user_id=?').all(req.user.id));
});
// Admin/manager: get all reads for a specific article
app.get('/api/kb/articles/:id/reads',auth,managerOrAdmin,(req,res)=>{
  res.json(db.prepare('SELECT r.*,u.name,u.avatar_color FROM kb_article_reads r JOIN users u ON u.id=r.user_id WHERE r.article_id=? ORDER BY r.read_at DESC').all(req.params.id));
});

// ---- CHANNELS ----
app.get('/api/channels',auth,(req,res)=>{
  res.json(db.prepare('SELECT * FROM channels ORDER BY name').all());
});
app.post('/api/channels',auth,adminOnly,(req,res)=>{
  const {name,description}=req.body;
  if (!name) return res.status(400).json({error:'Name required'});
  const slug=name.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  try {
    const r=db.prepare('INSERT INTO channels (name,description) VALUES (?,?)').run(slug,description||'');
    res.json({id:r.lastInsertRowid,name:slug,description:description||''});
  } catch { res.status(400).json({error:'Channel already exists'}); }
});
app.delete('/api/channels/:id',auth,adminOnly,(req,res)=>{
  const ch=db.prepare('SELECT name FROM channels WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({error:'Not found'});
  if (['general','announcements'].includes(ch.name)) return res.status(400).json({error:'Cannot delete default channels'});
  db.prepare('DELETE FROM channel_messages WHERE channel_id=?').run(req.params.id);
  db.prepare('DELETE FROM channels WHERE id=?').run(req.params.id);
  res.json({ok:true});
});
app.get('/api/channels/:id/messages',auth,(req,res)=>{
  const msgs=db.prepare('SELECT cm.id,cm.channel_id,cm.message,cm.created_at,u.id as sender_id,u.name,u.username,u.avatar_color FROM channel_messages cm JOIN users u ON cm.sender_id=u.id WHERE cm.channel_id=? ORDER BY cm.created_at DESC LIMIT 100').all(req.params.id);
  res.json(msgs.reverse());
});
app.get('/api/dm/:userId',auth,(req,res)=>{
  const other=parseInt(req.params.userId);
  const msgs=db.prepare('SELECT dm.id,dm.sender_id,dm.receiver_id,dm.message,dm.created_at,u.name,u.username,u.avatar_color FROM direct_messages dm JOIN users u ON dm.sender_id=u.id WHERE (dm.sender_id=? AND dm.receiver_id=?) OR (dm.sender_id=? AND dm.receiver_id=?) ORDER BY dm.created_at DESC LIMIT 100').all(req.user.id,other,other,req.user.id);
  db.prepare('UPDATE direct_messages SET read=1 WHERE sender_id=? AND receiver_id=?').run(other,req.user.id);
  res.json(msgs.reverse());
});
app.get('/api/unread',auth,(req,res)=>{
  res.json(db.prepare('SELECT sender_id,COUNT(*) as count FROM direct_messages WHERE receiver_id=? AND read=0 GROUP BY sender_id').all(req.user.id));
});

// ---- SOCKET.IO ----
const onlineUsers=new Map();
io.use((socket,next)=>{
  try {
    const cookie=socket.request.headers.cookie||'';
    const match=cookie.match(/token=([^;]+)/);
    if (!match) return next(new Error('No token'));
    socket.user=jwt.verify(match[1],JWT_SECRET);
    next();
  } catch { next(new Error('Invalid token')); }
});
io.on('connection',(socket)=>{
  onlineUsers.set(socket.user.id,socket.id);
  io.emit('online_users',Array.from(onlineUsers.keys()));
  socket.on('join_channel',(id)=>socket.join('ch_'+id));
  socket.on('leave_channel',(id)=>socket.leave('ch_'+id));
  socket.on('channel_message',({channelId,message})=>{
    if (!message?.trim()) return;
    const r=db.prepare('INSERT INTO channel_messages (channel_id,sender_id,message) VALUES (?,?,?)').run(channelId,socket.user.id,message.trim());
    const u=db.prepare('SELECT name,username,avatar_color FROM users WHERE id=?').get(socket.user.id);
    io.to('ch_'+channelId).emit('channel_message',{id:r.lastInsertRowid,channel_id:channelId,sender_id:socket.user.id,message:message.trim(),name:u.name,username:u.username,avatar_color:u.avatar_color,created_at:new Date().toISOString()});
  });
  socket.on('direct_message',({receiverId,message})=>{
    if (!message?.trim()) return;
    const r=db.prepare('INSERT INTO direct_messages (sender_id,receiver_id,message) VALUES (?,?,?)').run(socket.user.id,receiverId,message.trim());
    const u=db.prepare('SELECT name,username,avatar_color FROM users WHERE id=?').get(socket.user.id);
    const msg={id:r.lastInsertRowid,sender_id:socket.user.id,receiver_id:receiverId,message:message.trim(),name:u.name,username:u.username,avatar_color:u.avatar_color,created_at:new Date().toISOString()};
    socket.emit('direct_message',msg);
    const sid=onlineUsers.get(parseInt(receiverId));
    if (sid){io.to(sid).emit('direct_message',msg);io.to(sid).emit('dm_notification',{fromId:socket.user.id,name:u.name});}
  });
  socket.on('typing',({channelId,receiverId})=>{
    if (channelId) socket.to('ch_'+channelId).emit('typing',{userId:socket.user.id,name:socket.user.name,channelId});
    if (receiverId){const sid=onlineUsers.get(parseInt(receiverId));if(sid)io.to(sid).emit('typing',{userId:socket.user.id,name:socket.user.name,receiverId});}
  });
  socket.on('disconnect',()=>{onlineUsers.delete(socket.user.id);io.emit('online_users',Array.from(onlineUsers.keys()));});
});

httpServer.listen(PORT,'0.0.0.0',()=>console.log('Maverick Hub running on port '+PORT));
