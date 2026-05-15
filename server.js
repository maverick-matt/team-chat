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
    radius INTEGER DEFAULT 300,
    timezone TEXT DEFAULT 'Australia/Sydney'
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
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#2B5EA7',
    sort_order INTEGER DEFAULT 0
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
    notes TEXT DEFAULT '',
    position_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS timesheet_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clock_record_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    requested_clock_in DATETIME,
    requested_clock_out DATETIME,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    reviewed_by INTEGER,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// Migrations for existing tables
try { db.exec("ALTER TABLE stores ADD COLUMN timezone TEXT DEFAULT 'Australia/Sydney'"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN reports_to INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN position_id INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE roster_shifts ADD COLUMN position_id INTEGER"); } catch(e) {}

// Seed Maverick Campers store locations
if (!db.prepare('SELECT id FROM stores LIMIT 1').get()) {
  const stores = [
    ['Wangara WA','1 Quartz Way, Wangara WA 6065',-31.7932,115.8026,300,'Australia/Perth'],
    ['Prospect SA','142 Main North Rd, Prospect SA 5082',-34.8841,138.5994,300,'Australia/Adelaide'],
    ['Caboolture QLD','37B Lear Jet Drive, Caboolture QLD 4510',-27.0657,152.9453,300,'Australia/Brisbane'],
    ['Campbellfield VIC','1920 Hume Highway, Campbellfield VIC 3061',-37.6603,144.9644,300,'Australia/Melbourne'],
  ];
  stores.forEach(([name,address,lat,lng,radius,timezone]) =>
    db.prepare('INSERT INTO stores (name,address,lat,lng,radius,timezone) VALUES (?,?,?,?,?,?)').run(name,address,lat,lng,radius,timezone));
} else {
  // Ensure existing stores have the correct timezones
  const tzMap = {
    'Wangara WA':'Australia/Perth',
    'Prospect SA':'Australia/Adelaide',
    'Caboolture QLD':'Australia/Brisbane',
    'Campbellfield VIC':'Australia/Melbourne',
  };
  Object.entries(tzMap).forEach(([name,tz]) =>
    db.prepare("UPDATE stores SET timezone=? WHERE name=? AND (timezone IS NULL OR timezone='Australia/Sydney')").run(tz,name));
}

// Seed default positions
if (!db.prepare('SELECT id FROM positions LIMIT 1').get()) {
  const posSeeds=[
    ['Management','#1C3B6E',0],['Sales Team','#2B5EA7',1],
    ['Workshop Wangara','#10B981',2],['Workshop Adelaide','#10B981',3],
    ['Workshop Caboolture','#10B981',4],['Workshop Campbellfield','#10B981',5],
    ['Administration','#7A96B8',6],
  ];
  posSeeds.forEach(([name,color,sort_order])=>db.prepare('INSERT INTO positions (name,color,sort_order) VALUES (?,?,?)').run(name,color,sort_order));
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

// Enrich a clock record with human-readable location info
function enrichLocation(rec) {
  if (!rec) return rec;
  const inLat=rec.clock_in_lat, inLng=rec.clock_in_lng;
  const outLat=rec.clock_out_lat, outLng=rec.clock_out_lng;
  const store=db.prepare('SELECT name,lat,lng FROM stores WHERE id=?').get(rec.store_id);
  // Clock-in location
  if (inLat!=null&&inLng!=null&&store) {
    const dist=Math.round(haversineDist(inLat,inLng,store.lat,store.lng));
    rec.clock_in_location_label = dist<=200 ? store.name : null;
    rec.clock_in_location_dist  = dist;
    rec.clock_in_location_url   = dist>200 ? `https://www.google.com/maps?q=${inLat.toFixed(6)},${inLng.toFixed(6)}` : null;
    rec.clock_in_location_coords= dist>200 ? `${inLat.toFixed(5)},${inLng.toFixed(5)}` : null;
  } else {
    rec.clock_in_location_label=null;
    rec.clock_in_location_url=null;
    rec.clock_in_location_coords=null;
    rec.clock_in_location_dist=null;
  }
  // Clock-out location
  if (outLat!=null&&outLng!=null&&store) {
    const dist=Math.round(haversineDist(outLat,outLng,store.lat,store.lng));
    rec.clock_out_location_label = dist<=200 ? store.name : null;
    rec.clock_out_location_dist  = dist;
    rec.clock_out_location_url   = dist>200 ? `https://www.google.com/maps?q=${outLat.toFixed(6)},${outLng.toFixed(6)}` : null;
    rec.clock_out_location_coords= dist>200 ? `${outLat.toFixed(5)},${outLng.toFixed(5)}` : null;
  } else {
    rec.clock_out_location_label=null;
    rec.clock_out_location_url=null;
    rec.clock_out_location_coords=null;
    rec.clock_out_location_dist=null;
  }
  return rec;
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
app.put('/api/users/:id',auth,adminOnly,(req,res)=>{
  const {name,username,role}=req.body;
  if (!name||!username) return res.status(400).json({error:'Name and username required'});
  const existing=db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(username.toLowerCase().trim(),req.params.id);
  if (existing) return res.status(400).json({error:'Username already taken'});
  db.prepare('UPDATE users SET name=?,username=?,role=? WHERE id=?').run(name.trim(),username.toLowerCase().trim(),role||'member',req.params.id);
  res.json({ok:true});
});
app.put('/api/users/:id/password',auth,adminOnly,(req,res)=>{
  const {password}=req.body;
  if (!password||password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const hash=bcrypt.hashSync(password,10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.params.id);
  res.json({ok:true});
});
app.delete('/api/users/:id',auth,adminOnly,(req,res)=>{
  const t=db.prepare('SELECT role,id FROM users WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({error:'Not found'});
  if (t.role==='admin'&&t.id===req.user.id) return res.status(400).json({error:'Cannot delete your own admin account'});
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM user_stores WHERE user_id=?').run(req.params.id);
  db.prepare('UPDATE users SET reports_to=NULL WHERE reports_to=?').run(req.params.id);
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
  const {name,address,lat,lng,radius,timezone}=req.body;
  if (!name||lat==null||lng==null) return res.status(400).json({error:'Missing fields'});
  const r=db.prepare('INSERT INTO stores (name,address,lat,lng,radius,timezone) VALUES (?,?,?,?,?,?)').run(name,address||'',lat,lng,radius||300,timezone||'Australia/Sydney');
  res.json({id:r.lastInsertRowid,name,address,lat,lng,radius:radius||300,timezone:timezone||'Australia/Sydney'});
});
app.put('/api/stores/:id',auth,adminOnly,(req,res)=>{
  const {name,address,lat,lng,radius,timezone}=req.body;
  db.prepare('UPDATE stores SET name=?,address=?,lat=?,lng=?,radius=?,timezone=? WHERE id=?').run(name,address||'',lat,lng,radius||300,timezone||'Australia/Sydney',req.params.id);
  res.json({ok:true});
});
app.delete('/api/stores/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM stores WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM user_stores WHERE store_id=?').run(req.params.id);
  res.json({ok:true});
});

// ---- CLOCK ----
app.get('/api/clock/status',auth,(req,res)=>{
  const rec=db.prepare('SELECT cr.*,s.name as store_name,s.timezone FROM clock_records cr JOIN stores s ON s.id=cr.store_id WHERE cr.user_id=? AND cr.clock_out_at IS NULL ORDER BY cr.clock_in_at DESC LIMIT 1').get(req.user.id);
  res.json({clocked_in:!!rec,record:rec?enrichLocation(rec):null});
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
  const recs=db.prepare('SELECT cr.*,s.name as store_name,s.timezone,u.name as user_name FROM clock_records cr JOIN stores s ON s.id=cr.store_id JOIN users u ON u.id=cr.user_id WHERE cr.user_id=? ORDER BY cr.clock_in_at DESC LIMIT 50').all(uid);
  res.json(recs.map(enrichLocation));
});
app.get('/api/clock/all',auth,adminOnly,(req,res)=>{
  const recs=db.prepare('SELECT cr.*,s.name as store_name,s.timezone,u.name as user_name,u.avatar_color FROM clock_records cr JOIN stores s ON s.id=cr.store_id JOIN users u ON u.id=cr.user_id ORDER BY cr.clock_in_at DESC LIMIT 300').all();
  res.json(recs.map(enrichLocation));
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

// ---- POSITIONS ----
app.get('/api/positions',auth,(req,res)=>{
  res.json(db.prepare('SELECT * FROM positions ORDER BY sort_order,name').all());
});
app.post('/api/positions',auth,adminOnly,(req,res)=>{
  const {name,color,sort_order}=req.body;
  if (!name) return res.status(400).json({error:'Name required'});
  const r=db.prepare('INSERT INTO positions (name,color,sort_order) VALUES (?,?,?)').run(name,color||'#2B5EA7',sort_order||0);
  res.json({id:r.lastInsertRowid});
});
app.put('/api/positions/:id',auth,adminOnly,(req,res)=>{
  const {name,color,sort_order}=req.body;
  db.prepare('UPDATE positions SET name=?,color=?,sort_order=? WHERE id=?').run(name,color||'#2B5EA7',sort_order||0,req.params.id);
  res.json({ok:true});
});
app.delete('/api/positions/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM positions WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// User reporting structure + position
app.put('/api/users/:id/manager',auth,adminOnly,(req,res)=>{
  const {reports_to,position_id}=req.body;
  db.prepare('UPDATE users SET reports_to=?,position_id=? WHERE id=?').run(reports_to||null,position_id||null,req.params.id);
  res.json({ok:true});
});
app.get('/api/users/:id/profile',auth,(req,res)=>{
  const uid=parseInt(req.params.id);
  if (req.user.role!=='admin'&&req.user.id!==uid) return res.status(403).json({error:'Forbidden'});
  const u=db.prepare('SELECT u.*,m.name as manager_name,p.name as position_name,p.color as position_color FROM users u LEFT JOIN users m ON m.id=u.reports_to LEFT JOIN positions p ON p.id=u.position_id WHERE u.id=?').get(uid);
  res.json(u);
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
app.post('/api/rosters/:id/clone',auth,adminOnly,(req,res)=>{
  const {new_name,new_week_start}=req.body;
  if (!new_name||!new_week_start) return res.status(400).json({error:'New name and week start required'});
  const orig=db.prepare('SELECT * FROM rosters WHERE id=?').get(req.params.id);
  if (!orig) return res.status(404).json({error:'Roster not found'});
  const origShifts=db.prepare('SELECT * FROM roster_shifts WHERE roster_id=?').all(req.params.id);
  const origWeek=new Date(orig.week_start+'T00:00:00');
  const newWeek=new Date(new_week_start+'T00:00:00');
  const dayOffset=Math.round((newWeek-origWeek)/(864e5));
  const newRoster=db.prepare('INSERT INTO rosters (name,store_id,week_start,created_by) VALUES (?,?,?,?)').run(new_name,orig.store_id,new_week_start,req.user.id);
  origShifts.forEach(s=>{
    const newDate=new Date(s.shift_date+'T00:00:00');
    newDate.setDate(newDate.getDate()+dayOffset);
    db.prepare('INSERT INTO roster_shifts (roster_id,user_id,store_id,shift_date,start_time,end_time,role,notes,position_id) VALUES (?,?,?,?,?,?,?,?,?)').run(newRoster.lastInsertRowid,s.user_id,s.store_id,newDate.toISOString().slice(0,10),s.start_time,s.end_time,s.role,s.notes,s.position_id||null);
  });
  res.json({id:newRoster.lastInsertRowid,shifts_copied:origShifts.length});
});
app.get('/api/rosters/:id/shifts',auth,(req,res)=>{
  res.json(db.prepare('SELECT rs.*,u.name as user_name,u.avatar_color,s.name as store_name FROM roster_shifts rs JOIN users u ON u.id=rs.user_id JOIN stores s ON s.id=rs.store_id WHERE rs.roster_id=? ORDER BY rs.shift_date,rs.start_time').all(req.params.id));
});
app.post('/api/rosters/:id/shifts',auth,adminOnly,(req,res)=>{
  const {user_id,store_id,shift_date,start_time,end_time,role,notes,position_id}=req.body;
  if (!user_id||!store_id||!shift_date||!start_time||!end_time) return res.status(400).json({error:'Missing fields'});
  const r=db.prepare('INSERT INTO roster_shifts (roster_id,user_id,store_id,shift_date,start_time,end_time,role,notes,position_id) VALUES (?,?,?,?,?,?,?,?,?)').run(req.params.id,user_id,store_id,shift_date,start_time,end_time,role||'',notes||'',position_id||null);
  res.json({id:r.lastInsertRowid});
});
app.delete('/api/rosters/shifts/:id',auth,adminOnly,(req,res)=>{
  db.prepare('DELETE FROM roster_shifts WHERE id=?').run(req.params.id);
  res.json({ok:true});
});
app.get('/api/my/shifts',auth,(req,res)=>{
  const from=req.query.from||new Date().toISOString().slice(0,10);
  res.json(db.prepare('SELECT rs.*,r.name as roster_name,s.name as store_name,p.name as position_name,p.color as position_color FROM roster_shifts rs JOIN rosters r ON r.id=rs.roster_id JOIN stores s ON s.id=rs.store_id LEFT JOIN positions p ON p.id=rs.position_id WHERE rs.user_id=? AND rs.shift_date>=? ORDER BY rs.shift_date,rs.start_time LIMIT 30').all(req.user.id,from));
});
app.get('/api/all/shifts',auth,adminOnly,(req,res)=>{
  const from=req.query.from||new Date().toISOString().slice(0,10);
  const to=req.query.to||new Date(Date.now()+14*864e5).toISOString().slice(0,10);
  res.json(db.prepare('SELECT rs.*,u.name as user_name,u.avatar_color,s.name as store_name FROM roster_shifts rs JOIN users u ON u.id=rs.user_id JOIN stores s ON s.id=rs.store_id WHERE rs.shift_date>=? AND rs.shift_date<=? ORDER BY rs.shift_date,rs.start_time').all(from,to));
});

// ---- TIMESHEET EDITS ----
app.get('/api/timesheet/my-edits',auth,(req,res)=>{
  const edits=db.prepare('SELECT te.*,s.name as store_name,s.timezone,m.name as reviewer_name FROM timesheet_edits te JOIN clock_records cr ON cr.id=te.clock_record_id JOIN stores s ON s.id=cr.store_id LEFT JOIN users m ON m.id=te.reviewed_by WHERE te.user_id=? ORDER BY te.created_at DESC LIMIT 30').all(req.user.id);
  res.json(edits);
});
app.get('/api/timesheet/pending',auth,(req,res)=>{
  // Returns edits for users who report to this manager (or all if admin)
  let edits;
  if (req.user.role==='admin'){
    edits=db.prepare('SELECT te.*,u.name as user_name,u.avatar_color,cr.clock_in_at as orig_in,cr.clock_out_at as orig_out,s.name as store_name,s.timezone FROM timesheet_edits te JOIN users u ON u.id=te.user_id JOIN clock_records cr ON cr.id=te.clock_record_id JOIN stores s ON s.id=cr.store_id WHERE te.status=\'pending\' ORDER BY te.created_at DESC').all();
  } else {
    edits=db.prepare('SELECT te.*,u.name as user_name,u.avatar_color,cr.clock_in_at as orig_in,cr.clock_out_at as orig_out,s.name as store_name,s.timezone FROM timesheet_edits te JOIN users u ON u.id=te.user_id JOIN clock_records cr ON cr.id=te.clock_record_id JOIN stores s ON s.id=cr.store_id WHERE te.status=\'pending\' AND u.reports_to=? ORDER BY te.created_at DESC').all(req.user.id);
  }
  res.json(edits);
});
app.post('/api/timesheet/edits',auth,(req,res)=>{
  const {clock_record_id,requested_clock_in,requested_clock_out,reason}=req.body;
  if (!clock_record_id) return res.status(400).json({error:'Clock record required'});
  const rec=db.prepare('SELECT * FROM clock_records WHERE id=? AND user_id=?').get(clock_record_id,req.user.id);
  if (!rec) return res.status(404).json({error:'Record not found'});
  const existing=db.prepare("SELECT id FROM timesheet_edits WHERE clock_record_id=? AND status='pending'").get(clock_record_id);
  if (existing) return res.status(400).json({error:'A pending edit already exists for this record'});
  const r=db.prepare('INSERT INTO timesheet_edits (clock_record_id,user_id,requested_clock_in,requested_clock_out,reason) VALUES (?,?,?,?,?)').run(clock_record_id,req.user.id,requested_clock_in||null,requested_clock_out||null,reason||'');
  res.json({id:r.lastInsertRowid});
});
app.put('/api/timesheet/edits/:id',auth,(req,res)=>{
  const {status}=req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({error:'Invalid status'});
  const edit=db.prepare('SELECT te.*,u.reports_to FROM timesheet_edits te JOIN users u ON u.id=te.user_id WHERE te.id=?').get(req.params.id);
  if (!edit) return res.status(404).json({error:'Not found'});
  if (req.user.role!=='admin'&&edit.reports_to!==req.user.id) return res.status(403).json({error:'Not your report'});
  db.prepare('UPDATE timesheet_edits SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run(status,req.user.id,req.params.id);
  if (status==='approved'){
    db.prepare('UPDATE clock_records SET clock_in_at=COALESCE(?,clock_in_at),clock_out_at=COALESCE(?,clock_out_at) WHERE id=?').run(edit.requested_clock_in||null,edit.requested_clock_out||null,edit.clock_record_id);
  }
  res.json({ok:true});
});

// ---- TIMESHEET DISCREPANCY REPORT ----
app.get('/api/reports/timesheet',auth,(req,res)=>{
  if (req.user.role!=='admin'&&req.user.role!=='manager') return res.status(403).json({error:'Manager or Admin only'});
  const {from,to,store_id,user_id}=req.query;
  if (!from||!to) return res.status(400).json({error:'from and to dates required'});
  let q=`SELECT rs.id as shift_id, rs.shift_date, rs.start_time, rs.end_time, rs.role, rs.notes,
    u.id as user_id, u.name as user_name, u.avatar_color,
    s.id as store_id, s.name as store_name, s.timezone,
    p.name as position_name, p.color as position_color,
    cr.id as clock_record_id, cr.clock_in_at, cr.clock_out_at,
    te.id as edit_id, te.status as edit_status, te.requested_clock_in, te.requested_clock_out, te.reason as edit_reason
    FROM roster_shifts rs
    JOIN users u ON u.id=rs.user_id
    JOIN stores s ON s.id=rs.store_id
    LEFT JOIN positions p ON p.id=rs.position_id
    LEFT JOIN clock_records cr ON cr.user_id=rs.user_id AND date(cr.clock_in_at)=rs.shift_date AND cr.store_id=rs.store_id
    LEFT JOIN timesheet_edits te ON te.clock_record_id=cr.id AND te.status='approved'
    WHERE rs.shift_date>=? AND rs.shift_date<=?`;
  const args=[from,to];
  if (store_id){q+=' AND rs.store_id=?';args.push(store_id);}
  if (user_id){q+=' AND rs.user_id=?';args.push(user_id);}
  q+=' ORDER BY rs.shift_date,u.name';
  const reportRows=db.prepare(q).all(...args);
  // Enrich location data for each row that has a clock record
  reportRows.forEach(r=>{
    if (r.clock_record_id&&r.clock_in_at) {
      const cr=db.prepare('SELECT * FROM clock_records WHERE id=?').get(r.clock_record_id);
      if (cr) { const enriched=enrichLocation(cr); Object.assign(r,{clock_in_location_label:enriched.clock_in_location_label,clock_in_location_url:enriched.clock_in_location_url,clock_in_location_coords:enriched.clock_in_location_coords,clock_in_location_dist:enriched.clock_in_location_dist}); }
    } else { r.clock_in_location_label=null;r.clock_in_location_url=null;r.clock_in_location_coords=null;r.clock_in_location_dist=null; }
  });
  res.json(reportRows);
});

// Printable HTML timesheet report
app.get('/api/reports/timesheet/print',auth,(req,res)=>{
  if (req.user.role!=='admin'&&req.user.role!=='manager') return res.status(403).send('Forbidden');
  const {from,to,store_id}=req.query;
  if (!from||!to) return res.status(400).send('from and to required');
  let q=`SELECT rs.shift_date,rs.start_time,rs.end_time,rs.role,
    u.name as user_name,s.name as store_name,s.timezone,
    p.name as position_name,p.color as position_color,
    cr.clock_in_at,cr.clock_out_at,te.requested_clock_in,te.requested_clock_out,te.status as edit_status
    FROM roster_shifts rs JOIN users u ON u.id=rs.user_id JOIN stores s ON s.id=rs.store_id
    LEFT JOIN positions p ON p.id=rs.position_id
    LEFT JOIN clock_records cr ON cr.user_id=rs.user_id AND date(cr.clock_in_at)=rs.shift_date AND cr.store_id=rs.store_id
    LEFT JOIN timesheet_edits te ON te.clock_record_id=cr.id AND te.status='approved'
    WHERE rs.shift_date>=? AND rs.shift_date<=?`;
  const args=[from,to];
  if(store_id){q+=' AND rs.store_id=?';args.push(store_id);}
  q+=' ORDER BY s.name,rs.shift_date,u.name';
  const rows=db.prepare(q).all(...args);
  function toMins(t){if(!t)return null;const[h,m]=t.split(':').map(Number);return h*60+m;}
  function durStr(inAt,outAt,tz){
    if(!inAt||!outAt)return '—';
    const ms=new Date(outAt)-new Date(inAt);
    const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);
    return h+'h'+(m>0?' '+m+'m':'');
  }
  function fmtTZ(dt,tz){if(!dt)return '—';const s=String(dt);const d=new Date(s.includes('T')||s.endsWith('Z')?s:s.replace(' ','T')+'Z');return d.toLocaleTimeString('en-AU',{timeZone:tz||'Australia/Sydney',hour:'2-digit',minute:'2-digit'});}
  const grouped={};
  rows.forEach(r=>{
    const key=r.store_name;
    if(!grouped[key])grouped[key]={store:r.store_name,tz:r.timezone,rows:[]};
    const sched_in=toMins(r.start_time),sched_out=toMins(r.end_time);
    const _parseUTC=s=>{if(!s)return null;const t=String(s);return new Date(t.includes('T')||t.endsWith('Z')?t:t.replace(' ','T')+'Z');};
    const actual_in=r.clock_in_at?toMins(_parseUTC(r.clock_in_at).toLocaleTimeString('en-AU',{timeZone:r.timezone||'Australia/Sydney',hour:'2-digit',minute:'2-digit'}).replace(':',':')):null;
    const actual_out=r.clock_out_at?toMins(_parseUTC(r.clock_out_at).toLocaleTimeString('en-AU',{timeZone:r.timezone||'Australia/Sydney',hour:'2-digit',minute:'2-digit'}).replace(':',':')):null;
    let discrepancy='';
    if(sched_in!==null&&actual_in!==null){const diff=actual_in-sched_in;if(diff>5)discrepancy+=`Late ${diff}m. `;else if(diff<-5)discrepancy+=`Early in ${Math.abs(diff)}m. `;}
    if(sched_out!==null&&actual_out!==null){const diff=actual_out-sched_out;if(diff>15)discrepancy+=`+${diff}m overtime. `;else if(diff<-5)discrepancy+=`Left ${Math.abs(diff)}m early. `;}
    if(!r.clock_in_at&&r.shift_date<new Date().toISOString().slice(0,10))discrepancy='No clock record';
    grouped[key].rows.push({...r,discrepancy});
  });
  // Enrich location data for the report rows
  rows.forEach(r=>{
    if(r.clock_in_at&&r.clock_in_lat!=null){
      const store=db.prepare('SELECT lat,lng FROM stores WHERE id=?').get(r.store_id||0);
      if(store){
        const d=Math.round(haversineDist(r.clock_in_lat,r.clock_in_lng,store.lat,store.lng));
        r._inLoc=d<=200?r.store_name:`<a href="https://www.google.com/maps?q=${r.clock_in_lat},${r.clock_in_lng}" style="color:#2B5EA7">Maps (${d}m away)</a>`;
      }
    } else { r._inLoc='No GPS'; }
  });
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Timesheet Report ${from} to ${to}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:12px;color:#0D1E35;padding:24px}
h1{font-size:18px;color:#1C3B6E;margin-bottom:4px}
.meta{color:#7A96B8;font-size:11px;margin-bottom:20px}
.store-head{background:#1C3B6E;color:#fff;padding:8px 12px;font-weight:700;font-size:13px;margin-top:20px;border-radius:4px 4px 0 0}
table{width:100%;border-collapse:collapse;margin-bottom:20px}
th{background:#F4F7FB;color:#1C3B6E;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:7px 10px;border:1px solid #d1d9e8;text-align:left}
td{padding:6px 10px;border:1px solid #d1d9e8;font-size:11px;vertical-align:top}
tr:nth-child(even) td{background:#fafbfd}
.disc{color:#EF4444;font-size:10px;font-weight:600}
.ok{color:#10B981;font-size:10px}
.no-record{color:#EF4444}
@media print{body{padding:12px}.store-head{margin-top:14px}table{page-break-inside:avoid}}
</style></head><body>
<h1>Timesheet Report — ${from} to ${to}</h1>
<div class="meta">Generated ${new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} · Maverick Campers & Caravans</div>
${Object.values(grouped).map(g=>`
<div class="store-head">📍 ${g.store} (${g.tz||'AU'})</div>
<table><thead><tr><th>Date</th><th>Staff Member</th><th>Position</th><th>Rostered</th><th>Clocked In</th><th>Clock-in Location</th><th>Clocked Out</th><th>Duration</th><th>Discrepancy</th></tr></thead>
<tbody>${g.rows.map(r=>`<tr>
<td>${new Date(r.shift_date+'T00:00:00').toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})}</td>
<td>${r.user_name}</td>
<td>${r.position_name||r.role||'—'}</td>
<td>${r.start_time}–${r.end_time}</td>
<td>${r.clock_in_at?fmtTZ(r.clock_in_at,r.timezone):'<span class="no-record">—</span>'}</td>
<td>${r._inLoc||'—'}</td>
<td>${r.clock_out_at?fmtTZ(r.clock_out_at,r.timezone):'<span class="no-record">—</span>'}</td>
<td>${durStr(r.clock_in_at,r.clock_out_at,r.timezone)}</td>
<td>${r.discrepancy?`<span class="disc">${r.discrepancy}</span>`:'<span class="ok">✓ On time</span>'}</td>
</tr>`).join('')}</tbody></table>`).join('')}
<script>window.print()</script>
</body></html>`;
  res.send(html);
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
