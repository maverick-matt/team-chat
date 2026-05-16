const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

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
  CREATE TABLE IF NOT EXISTS group_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS group_message_reads (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_id INTEGER DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
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
  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    website TEXT,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    last_researched TEXT DEFAULT '2026-05-16'
  );
  CREATE TABLE IF NOT EXISTS competitor_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competitor_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    price_from TEXT,
    solar_watts INTEGER,
    battery_ah INTEGER,
    battery_type TEXT,
    bms TEXT,
    water_tank_l INTEGER,
    length_ft REAL,
    tare_kg INTEGER,
    atm_kg INTEGER,
    key_features TEXT,
    comparable_maverick TEXT,
    notes TEXT
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
try { db.exec("ALTER TABLE users ADD COLUMN mfa_secret TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN ensuite TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN grey_water_l INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN hot_water TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN inverter_w INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE competitors ADD COLUMN last_researched TEXT DEFAULT '2026-05-16'"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN solar_panel_type TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN solar_mounting TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN solar_brand TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE competitor_models ADD COLUMN solar_notes TEXT"); } catch(e) {}
db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
)`);

function sendResetEmail(toEmail, toName, resetUrl) {
  if (!process.env.SMTP_HOST) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Maverick Hub – Password Reset',
    html: `<p>Hi ${toName},</p><p>Click the link below to reset your Maverick Hub password (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`
  }).catch(()=>{});
}

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
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(username?.toLowerCase?.().trim());
  if (!user||!bcrypt.compareSync(password,user.password_hash))
    return res.status(401).json({error:'Invalid username or password'});
  if (user.mfa_enabled) {
    const tempToken=jwt.sign({id:user.id,mfa_pending:true},JWT_SECRET,{expiresIn:'5m'});
    return res.json({mfa_required:true,temp_token:tempToken});
  }
  const token=jwt.sign({id:user.id,username:user.username,name:user.name,role:user.role},JWT_SECRET,{expiresIn:'7d'});
  res.cookie('token',token,{httpOnly:true,maxAge:7*24*60*60*1000});
  res.json({id:user.id,username:user.username,name:user.name,role:user.role,avatar_color:user.avatar_color});
});

app.post('/api/login/mfa',(req,res)=>{
  const {temp_token,code}=req.body;
  let payload;
  try{payload=jwt.verify(temp_token,JWT_SECRET);}catch{return res.status(401).json({error:'Session expired, please log in again'});}
  if(!payload.mfa_pending) return res.status(401).json({error:'Invalid token'});
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if(!user||!user.mfa_enabled||!user.mfa_secret) return res.status(401).json({error:'MFA not configured'});
  const ok=speakeasy.totp.verify({secret:user.mfa_secret,encoding:'base32',token:String(code).replace(/\s/g,''),window:1});
  if(!ok) return res.status(401).json({error:'Invalid authentication code'});
  const token=jwt.sign({id:user.id,username:user.username,name:user.name,role:user.role},JWT_SECRET,{expiresIn:'7d'});
  res.cookie('token',token,{httpOnly:true,maxAge:7*24*60*60*1000});
  res.json({id:user.id,username:user.username,name:user.name,role:user.role,avatar_color:user.avatar_color});
});

app.post('/api/forgot-password',(req,res)=>{
  const {username}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(username?.toLowerCase?.().trim());
  if(user&&user.email){
    const token=crypto.randomBytes(32).toString('hex');
    const expires=new Date(Date.now()+60*60*1000).toISOString().replace('T',' ').split('.')[0];
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO password_reset_tokens (user_id,token,expires_at) VALUES (?,?,?)').run(user.id,token,expires);
    const resetUrl=`${process.env.APP_URL||'https://teamhub.maverickapp.com.au'}/reset-password.html?token=${token}`;
    sendResetEmail(user.email,user.name,resetUrl);
  }
  res.json({ok:true});
});

app.post('/api/reset-password',(req,res)=>{
  const {token,password}=req.body;
  if(!token||!password) return res.status(400).json({error:'Missing fields'});
  if(password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const record=db.prepare('SELECT * FROM password_reset_tokens WHERE token=? AND used=0').get(token);
  if(!record) return res.status(400).json({error:'Invalid or expired reset link'});
  if(new Date(record.expires_at+'Z')<new Date()) return res.status(400).json({error:'Reset link has expired. Please request a new one.'});
  const hash=bcrypt.hashSync(password,10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,record.user_id);
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(record.id);
  res.json({ok:true});
});

// ---- MFA ----
app.get('/api/mfa/status',auth,(req,res)=>{
  const u=db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get(req.user.id);
  res.json({mfa_enabled:!!u.mfa_enabled});
});
app.get('/api/mfa/setup',auth,async(req,res)=>{
  const secret=speakeasy.generateSecret({name:`Maverick Hub (${req.user.username})`});
  db.prepare('UPDATE users SET mfa_secret=?,mfa_enabled=0 WHERE id=?').run(secret.base32,req.user.id);
  const qr=await QRCode.toDataURL(secret.otpauth_url);
  res.json({secret:secret.base32,qr});
});
app.post('/api/mfa/enable',auth,(req,res)=>{
  const {code}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(!user.mfa_secret) return res.status(400).json({error:'No MFA setup in progress'});
  const ok=speakeasy.totp.verify({secret:user.mfa_secret,encoding:'base32',token:String(code).replace(/\s/g,''),window:1});
  if(!ok) return res.status(400).json({error:'Invalid code – please try again'});
  db.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').run(req.user.id);
  res.json({ok:true});
});
app.post('/api/mfa/disable',auth,adminOnly,(req,res)=>{
  const {password}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(!bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:'Incorrect password'});
  db.prepare('UPDATE users SET mfa_enabled=0,mfa_secret=NULL WHERE id=?').run(req.user.id);
  res.json({ok:true});
});

app.post('/api/logout',(req,res)=>{res.clearCookie('token');res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>{
  res.json(db.prepare('SELECT id,username,name,role,avatar_color FROM users WHERE id=?').get(req.user.id));
});

// ---- USERS ----
const COLORS=['#F59E0B','#10B981','#3B82F6','#8B5CF6','#EC4899','#EF4444','#06B6D4','#84CC16'];
app.get('/api/users',auth,(req,res)=>{
  res.json(db.prepare('SELECT id,username,name,role,avatar_color,email,mfa_enabled FROM users ORDER BY name').all());
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
  const {name,username,role,email}=req.body;
  if (!name||!username) return res.status(400).json({error:'Name and username required'});
  const existing=db.prepare('SELECT id FROM users WHERE username=? AND id!=?').get(username.toLowerCase().trim(),req.params.id);
  if (existing) return res.status(400).json({error:'Username already taken'});
  db.prepare('UPDATE users SET name=?,username=?,role=?,email=? WHERE id=?').run(name.trim(),username.toLowerCase().trim(),role||'member',email?.trim()||null,req.params.id);
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

// ---- ORG CHART ----
app.get('/api/org-chart',auth,(req,res)=>{
  res.json(db.prepare(`
    SELECT u.id,u.name,u.role,u.avatar_color,u.reports_to,u.position_id,
      p.name as position_name,p.color as position_color,
      (SELECT COUNT(*) FROM users sub WHERE sub.reports_to=u.id) as direct_reports
    FROM users u LEFT JOIN positions p ON p.id=u.position_id ORDER BY COALESCE(p.sort_order,999),u.name
  `).all());
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

// ---- GROUP CHATS ----
app.get('/api/groups',auth,(req,res)=>{
  const groups=db.prepare(`
    SELECT gc.id,gc.name,gc.created_by,gc.created_at,
      (SELECT COUNT(*) FROM group_members WHERE group_id=gc.id) as member_count,
      (SELECT COUNT(*) FROM group_messages gm WHERE gm.group_id=gc.id
        AND gm.id>(SELECT COALESCE(last_read_id,0) FROM group_message_reads WHERE group_id=gc.id AND user_id=?)) as unread
    FROM group_chats gc
    JOIN group_members gm ON gm.group_id=gc.id AND gm.user_id=?
    ORDER BY gc.created_at DESC
  `).all(req.user.id,req.user.id);
  res.json(groups);
});

app.post('/api/groups',auth,(req,res)=>{
  let {name,member_ids}=req.body;
  if(!Array.isArray(member_ids)||!member_ids.length) return res.status(400).json({error:'Add at least one member'});
  // Auto-name if blank
  if(!name||!name.trim()){
    const names=db.prepare(`SELECT name FROM users WHERE id IN (${member_ids.map(()=>'?').join(',')}) ORDER BY name LIMIT 3`).all(...member_ids).map(u=>u.name.split(' ')[0]);
    name='Group: '+names.join(', ')+(member_ids.length>3?'…':'');
  }
  const r=db.prepare('INSERT INTO group_chats (name,created_by) VALUES (?,?)').run(name.trim(),req.user.id);
  const gid=r.lastInsertRowid;
  // Add creator + all specified members
  const allMembers=[...new Set([req.user.id,...member_ids.map(Number)])];
  allMembers.forEach(uid=>db.prepare('INSERT OR IGNORE INTO group_members (group_id,user_id) VALUES (?,?)').run(gid,uid));
  res.json({id:gid,name:name.trim(),member_count:allMembers.length});
});

app.get('/api/groups/:id',auth,(req,res)=>{
  const gid=req.params.id;
  const member=db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(gid,req.user.id);
  if(!member) return res.status(403).json({error:'Not a member'});
  const group=db.prepare('SELECT * FROM group_chats WHERE id=?').get(gid);
  const members=db.prepare('SELECT u.id,u.name,u.avatar_color,u.role FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=?').all(gid);
  res.json({...group,members});
});

app.post('/api/groups/:id/members',auth,(req,res)=>{
  const {user_ids}=req.body;
  const group=db.prepare('SELECT * FROM group_chats WHERE id=?').get(req.params.id);
  if(!group) return res.status(404).json({error:'Group not found'});
  const isMember=db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(req.params.id,req.user.id);
  if(!isMember) return res.status(403).json({error:'Not a member'});
  if(group.created_by!==req.user.id&&req.user.role!=='admin') return res.status(403).json({error:'Only the group creator or admin can add members'});
  (user_ids||[]).forEach(uid=>db.prepare('INSERT OR IGNORE INTO group_members (group_id,user_id) VALUES (?,?)').run(req.params.id,Number(uid)));
  res.json({ok:true});
});

app.delete('/api/groups/:id/members/:uid',auth,(req,res)=>{
  const group=db.prepare('SELECT * FROM group_chats WHERE id=?').get(req.params.id);
  if(!group) return res.status(404).json({error:'Not found'});
  const targetUid=parseInt(req.params.uid);
  // Can remove yourself (leave), or creator/admin can remove others
  const canRemove=targetUid===req.user.id||group.created_by===req.user.id||req.user.role==='admin';
  if(!canRemove) return res.status(403).json({error:'Not allowed'});
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(req.params.id,targetUid);
  res.json({ok:true});
});

app.put('/api/groups/:id',auth,(req,res)=>{
  const {name}=req.body;
  const group=db.prepare('SELECT * FROM group_chats WHERE id=?').get(req.params.id);
  if(!group) return res.status(404).json({error:'Not found'});
  if(group.created_by!==req.user.id&&req.user.role!=='admin') return res.status(403).json({error:'Only creator or admin can rename'});
  db.prepare('UPDATE group_chats SET name=? WHERE id=?').run(name.trim(),req.params.id);
  res.json({ok:true});
});

app.delete('/api/groups/:id',auth,(req,res)=>{
  const group=db.prepare('SELECT * FROM group_chats WHERE id=?').get(req.params.id);
  if(!group) return res.status(404).json({error:'Not found'});
  if(group.created_by!==req.user.id&&req.user.role!=='admin') return res.status(403).json({error:'Only creator or admin can delete'});
  db.prepare('DELETE FROM group_messages WHERE group_id=?').run(req.params.id);
  db.prepare('DELETE FROM group_members WHERE group_id=?').run(req.params.id);
  db.prepare('DELETE FROM group_message_reads WHERE group_id=?').run(req.params.id);
  db.prepare('DELETE FROM group_chats WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

app.get('/api/groups/:id/messages',auth,(req,res)=>{
  const member=db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(req.params.id,req.user.id);
  if(!member) return res.status(403).json({error:'Not a member'});
  const msgs=db.prepare(`SELECT gm.id,gm.group_id,gm.message,gm.created_at,u.id as sender_id,u.name,u.username,u.avatar_color,u.role
    FROM group_messages gm JOIN users u ON u.id=gm.sender_id WHERE gm.group_id=? ORDER BY gm.created_at DESC LIMIT 100`).all(req.params.id);
  // Mark as read
  const lastId=msgs.length?msgs[0].id:0;
  db.prepare('INSERT OR REPLACE INTO group_message_reads (group_id,user_id,last_read_id) VALUES (?,?,?)').run(req.params.id,req.user.id,lastId);
  res.json(msgs.reverse());
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
  socket.on('join_group',(id)=>socket.join('grp_'+id));
  socket.on('leave_group',(id)=>socket.leave('grp_'+id));
  socket.on('group_message',({groupId,message})=>{
    if(!message?.trim()) return;
    const member=db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').get(groupId,socket.user.id);
    if(!member) return;
    const r=db.prepare('INSERT INTO group_messages (group_id,sender_id,message) VALUES (?,?,?)').run(groupId,socket.user.id,message.trim());
    const u=db.prepare('SELECT name,username,avatar_color,role FROM users WHERE id=?').get(socket.user.id);
    const msg={id:r.lastInsertRowid,group_id:groupId,sender_id:socket.user.id,message:message.trim(),name:u.name,username:u.username,avatar_color:u.avatar_color,role:u.role,created_at:new Date().toISOString()};
    io.to('grp_'+groupId).emit('group_message',msg);
    const members=db.prepare('SELECT user_id FROM group_members WHERE group_id=? AND user_id!=?').all(groupId,socket.user.id);
    members.forEach(m=>{const sid=onlineUsers.get(m.user_id);if(sid)io.to(sid).emit('group_notification',{groupId,fromName:u.name,groupName:db.prepare('SELECT name FROM group_chats WHERE id=?').get(groupId)?.name});});
  });
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

// ---- COMPETITOR RESEARCH ----
const Anthropic = process.env.ANTHROPIC_API_KEY ? new (require('@anthropic-ai/sdk'))() : null;

app.get('/api/competitors', auth, (req,res) => {
  const competitors = db.prepare('SELECT * FROM competitors ORDER BY sort_order,name').all();
  competitors.forEach(c => {
    c.models = db.prepare('SELECT * FROM competitor_models WHERE competitor_id=? ORDER BY name').all(c.id);
    c.models.forEach(m => { try { m.key_features = JSON.parse(m.key_features||'[]'); } catch { m.key_features=[]; } });
  });
  const oldest = db.prepare('SELECT MIN(last_researched) as oldest FROM competitors').get();
  res.json({ competitors, last_researched: oldest?.oldest || '2026-05-16' });
});

app.get('/api/competitors/:id/models', auth, (req,res) => {
  const models = db.prepare('SELECT * FROM competitor_models WHERE competitor_id=? ORDER BY name').all(req.params.id);
  models.forEach(m => { try { m.key_features = JSON.parse(m.key_features||'[]'); } catch { m.key_features=[]; } });
  res.json(models);
});

app.post('/api/competitors/ai-query', auth, async (req,res) => {
  const {question} = req.body;
  if (!question) return res.status(400).json({error:'No question provided'});
  if (!Anthropic) return res.status(503).json({error:'AI not configured — add ANTHROPIC_API_KEY to .env'});

  const competitors = db.prepare('SELECT * FROM competitors ORDER BY sort_order,name').all();
  competitors.forEach(c => {
    c.models = db.prepare('SELECT * FROM competitor_models WHERE competitor_id=?').all(c.id);
    c.models.forEach(m => { try { m.key_features = JSON.parse(m.key_features||'[]'); } catch { m.key_features=[]; } });
  });

  const competitorContext = competitors.map(c =>
    `## ${c.name} (${c.website})\n${c.description}\n\nModels:\n` +
    c.models.map(m =>
      `- **${m.name}** (${m.category})\n` +
      `  Price: ${m.price_from||'N/A'} | Solar: ${m.solar_watts ? m.solar_watts+'W' : 'N/A'} | Battery: ${m.battery_ah ? m.battery_ah+'Ah '+m.battery_type : 'N/A'} | BMS: ${m.bms||'N/A'}\n` +
      `  Water: ${m.water_tank_l ? m.water_tank_l+'L' : 'N/A'} | Length: ${m.length_ft ? m.length_ft+"ft" : 'N/A'} | Tare: ${m.tare_kg ? m.tare_kg+'kg' : 'N/A'} | ATM: ${m.atm_kg ? m.atm_kg+'kg' : 'N/A'}\n` +
      `  Features: ${m.key_features.join(', ')||'N/A'}`
    ).join('\n')
  ).join('\n\n');

  const maverickContext = `## Maverick Campers — Our Products
**Falcon Range (Off-Road Caravans):** Flagship range with full composite construction, Al-Ko or Cruisemaster independent suspension, 265/75R16 tyres with Timken bearings.
- Falcon 17DL (top seller): 1 x 400Ah Lithium Battery, 600W+ Renogy solar, Arana instant hot water, 160–200L fresh water, 3000W inverter, reverse cycle A/C, diesel heater, electric bed lift, slide-out kitchen
- Falcon 21DL: Largest model, full dual-living, premium spec throughout
- Falcon 196: 19.6ft, maximum off-grid living space
- Falcon 17C, 16HL, 156C, 146C: Ranging from entry-level to full touring spec

**Viper Range (Hybrid Caravans):** Pop-up roof for full standing height at camp, lighter towing profile
- Viper 16DL Platinum Hybrid (most popular): full ensuite, queen bed, separate dining and lounge
- Viper 16C, Viper 13DL, Viper 13: Range from compact to full-size hybrid

**Cobra Range (Hard Lid Hybrids):** Hard lid pop-top (HL) — rigid composite lid, more durable than canvas
- Cobra 16HL, Cobra 146HL

**Storm Range (Compact Caravans):** Entry-level accessible price point
- Storm 12 Pop Top, Storm 9 Compact

**Key Maverick Advantages:** 3-year structural warranty, composite construction (no rot/rust), Timken wheel bearings, Renogy solar systems, Australian-made quality`;

  try {
    const response = await Anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `You are a specialist competitive intelligence assistant for Maverick Campers staff. Your ONLY purpose is to answer questions about caravans, camper trailers, and the Australian caravan industry — including competitor products, Maverick Campers models, specs, features, pricing, and sales talking points.

STRICT SCOPE: Only answer questions related to caravans, camper trailers, towing, camping, off-road travel, caravan features, or the Australian RV industry. If asked anything outside this scope (coding, politics, general knowledge, personal advice, etc.), respond: "I'm only able to help with caravan and competitor research questions. Please ask about caravans, specs, or competitors."

Be factual, concise, and helpful. Always present Maverick Campers positively where accurate. When specs are unknown, say so — never guess.

Current competitor data:
${competitorContext}

${maverickContext}`,
      messages: [{ role: 'user', content: question }]
    });
    res.json({ answer: response.content[0].text });
  } catch(e) {
    res.status(500).json({ error: 'AI query failed: ' + e.message });
  }
});

// Bulk-update endpoint — called by the weekly remote research agent
app.post('/api/competitors/bulk-update', (req, res) => {
  const key = req.headers['x-update-key'] || req.body?.update_key;
  if (!key || key !== process.env.COMPETITOR_UPDATE_KEY)
    return res.status(401).json({error: 'Unauthorised'});

  const {brands} = req.body; // array of brand objects with models[]
  if (!Array.isArray(brands) || !brands.length)
    return res.status(400).json({error: 'No brands provided'});

  const today = new Date().toISOString().split('T')[0];
  let updated = 0, errors = [];

  const updateTx = db.transaction(() => {
    brands.forEach(brand => {
      const existing = db.prepare('SELECT id FROM competitors WHERE name=?').get(brand.brand || brand.name);
      if (!existing) { errors.push(`Brand not found: ${brand.brand||brand.name}`); return; }
      // Update brand description and last_researched
      db.prepare('UPDATE competitors SET description=?,last_researched=? WHERE id=?')
        .run(brand.description||null, brand.last_researched||today, existing.id);
      // Update each model
      (brand.models||[]).forEach(m => {
        const existingModel = db.prepare('SELECT id FROM competitor_models WHERE competitor_id=? AND name=?').get(existing.id, m.name);
        if (existingModel) {
          db.prepare(`UPDATE competitor_models SET category=?,price_from=?,solar_watts=?,battery_ah=?,battery_type=?,
            bms=?,water_tank_l=?,grey_water_l=?,length_ft=?,tare_kg=?,atm_kg=?,key_features=?,comparable_maverick=?,
            ensuite=?,hot_water=?,inverter_w=? WHERE id=?`)
            .run(m.category||null, m.price_from||null, m.solar_watts||null, m.battery_ah||null,
              m.battery_type||null, m.bms||null, m.water_tank_l||null, m.grey_water_l||null,
              m.length_ft||null, m.tare_kg||null, m.atm_kg||null,
              JSON.stringify(m.key_features||[]), m.comparable_maverick||null,
              m.ensuite||null, m.hot_water||null, m.inverter_w||null, existingModel.id);
          updated++;
        } else {
          // Insert new model
          db.prepare(`INSERT INTO competitor_models (competitor_id,name,category,price_from,solar_watts,battery_ah,
            battery_type,bms,water_tank_l,grey_water_l,length_ft,tare_kg,atm_kg,key_features,comparable_maverick,
            ensuite,hot_water,inverter_w) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(existing.id, m.name, m.category||null, m.price_from||null, m.solar_watts||null,
              m.battery_ah||null, m.battery_type||null, m.bms||null, m.water_tank_l||null,
              m.grey_water_l||null, m.length_ft||null, m.tare_kg||null, m.atm_kg||null,
              JSON.stringify(m.key_features||[]), m.comparable_maverick||null,
              m.ensuite||null, m.hot_water||null, m.inverter_w||null);
          updated++;
        }
      });
    });
  });

  try {
    updateTx();
    console.log(`Competitor bulk-update: ${updated} models updated on ${today}`);
    res.json({ok: true, updated, errors, date: today});
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

// ---- COMPETITOR DATA SEED ----
// Update ensuite + grey_water on existing records if columns just added
try {
  const ensuiteMap = {
    'XT17HRT+ MKIII Family':'Separate','XT19HRT MKIII':'Separate','XT16HR Island MKIII':'Separate',
    'Tanami X15 Series 3':'Separate','Tanami X13 Hybrid':'Combo',
    'Stirling GT MK3':'Combo','Parkes 15 Quad MK4':'Combo','VZ5400 HR Premium Hard Top':'Separate',
    'Scout-17 Gen3 Off-Road':'Separate','Scout-19 Off-Road':'Separate','SC-FF6 Camper Trailer':'Combo',
    'Infinity 15':'Separate','Sirocco Grande':'Separate','Stealth 16':'Separate',
    'Warrior 15 Off-Road Hybrid':'Combo','Warrior 13 Off-Road Hybrid':'Combo',
    'Iridium 15 GEN II Hybrid':'Combo','Marlu Hybrid':'Separate',
    'Mars 15 Premium MKII':'Combo','Venus 17HR Off-Road':'Combo',
    'Frost 13 Off-Road Hybrid':'Combo','Glacier 14 (2026)':'Combo','Glacier 16 Double Bunk':'Combo',
    'Venture 15S Pop-Top Hybrid':'Combo','Tourer 16HT Hard-Top Hybrid':'Separate','Tourer 18HT3 Hard-Top Family':'Separate',
  };
  Object.entries(ensuiteMap).forEach(([name,val]) => db.prepare('UPDATE competitor_models SET ensuite=? WHERE name=? AND ensuite IS NULL').run(val,name));
  // Fix BMS to show manufacturer name
  const bmsMap = {
    'XT17HRT+ MKIII Family':'Redarc Manager 30','XT19HRT MKIII':'Redarc Manager 30','XT16HR Island MKIII':'Redarc Manager 30',
    'Tanami X15 Series 3':'Renogy REGO','Tanami X13 Hybrid':'Renogy REGO',
    'Stirling GT MK3':'Victron','Parkes 15 Quad MK4':'Victron','VZ5400 HR Premium Hard Top':'Victron',
    'Warrior 15 Off-Road Hybrid':'Projecta','Warrior 13 Off-Road Hybrid':'Projecta',
    'SC-FF6 Camper Trailer':'Projecta','Scout-17 Gen3 Off-Road':'Projecta','Scout-19 Off-Road':'Projecta',
  };
  Object.entries(bmsMap).forEach(([name,val]) => db.prepare('UPDATE competitor_models SET bms=? WHERE name=? AND (bms IS NULL OR bms=\'Yes\')').run(val,name));
} catch(e) {}

if (!db.prepare('SELECT id FROM competitors LIMIT 1').get()) {
  const insertComp = db.prepare('INSERT INTO competitors (name,website,description,sort_order) VALUES (?,?,?,?)');
  const insertModel = db.prepare('INSERT INTO competitor_models (competitor_id,name,category,price_from,solar_watts,battery_ah,battery_type,bms,water_tank_l,length_ft,tare_kg,atm_kg,key_features,comparable_maverick,ensuite) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

  const seedData = [
    { name:'MDC Caravans', website:'https://mdccaravans.com.au', description:'Market Direct Campers (MDC) is one of Australia\'s largest off-road caravan and camper trailer brands. Known for aggressive off-grid power systems and heavy-duty construction at competitive price points.', sort:1, models:[
      { name:'XT17HRT+ MKIII Family', cat:'Off-Road Hybrid Caravan', price:'$89,990', solar:875, bat:600, batType:'Lithium', bms:'Yes', water:160, len:17, tare:2810, atm:3500, features:['2000W auto-transfer inverter','150L Thetford fridge/freezer','Front-load washing machine','Reverse cycle A/C + diesel heating','External slide-out kitchen','80L grey water tank'], mav:'Falcon 17DL' },
      { name:'XT19HRT MKIII', cat:'Off-Road Hybrid Caravan', price:'$99,990', solar:1225, bat:600, batType:'Lithium', bms:'Yes', water:160, len:19, tare:2940, atm:3500, features:['3000W inverter','175L fridge/freezer','Induction + gas cooktop','Front-load washing machine','External slide-out kitchen + internal kitchenette'], mav:'Falcon 196' },
      { name:'XT16HR Island MKIII', cat:'Off-Road Hybrid Caravan', price:'$84,990', solar:700, bat:600, batType:'Lithium', bms:'Yes', water:160, len:16, tare:null, atm:null, features:['2000W inverter','Separate ensuite','Twin 80L fresh water tanks','3-berth layout'], mav:'Viper 16DL' },
    ]},
    { name:'Austrack Campers', website:'https://austrackcampers.com.au', description:'Queensland-based manufacturer specialising in hybrid off-road campers with market-leading solar and lithium capacity. Sold through major retailers including Anaconda.', sort:2, models:[
      { name:'Tanami X15 Series 3', cat:'Off-Road Hybrid Camper', price:null, solar:900, bat:690, batType:'LiFePO4 Lithium', bms:'Yes — Renogy REGO with touchscreen + Bluetooth', water:240, len:15, tare:2350, atm:3000, features:['3000W inverter','150A AC mains charger','60A DC-DC + MPPT solar','Can run A/C off-grid','Twin 120L fresh water tanks','80L grey water tank','Independent trailing arm suspension'], mav:'Falcon 17DL' },
      { name:'Tanami X13 Hybrid', cat:'Off-Road Hybrid Camper', price:null, solar:300, bat:300, batType:'AGM (Lithium option available)', bms:'Yes', water:240, len:13, tare:2090, atm:2750, features:['Twin 120L fresh water tanks','80L grey water tank','Independent trailing arm suspension','Lithium upgrade available'], mav:'Viper 13' },
    ]},
    { name:'Ezytrail Campers', website:'https://ezytrail.com.au', description:'Victorian manufacturer offering a broad range from budget forward-fold camper trailers through to full hybrid caravans. Known for Victron electrical systems with Bluetooth monitoring.', sort:3, models:[
      { name:'Stirling GT MK3', cat:'Forward Fold Hard Floor Camper', price:null, solar:null, bat:200, batType:'AGM Deep Cycle — Victron BMS', bms:'Yes — Victron with Bluetooth', water:165, len:18.5, tare:1757, atm:2250, features:['Victron off-grid system','Bluetooth battery monitoring','120L rear + 45L front stainless tanks','Travel height 1.9m'], mav:'Falcon 146C' },
      { name:'Parkes 15 Quad MK4', cat:'Off-Road Hybrid Caravan', price:null, solar:1190, bat:null, batType:'Lithium', bms:'Yes', water:240, len:15, tare:2330, atm:2900, features:['1190W solar standard','Twin 120L fresh water tanks','75L grey water tank','Family quad layout','Pop-top hybrid design'], mav:'Viper 16DL' },
      { name:'VZ5400 HR Premium Hard Top', cat:'Luxury Hard Top Hybrid Caravan', price:null, solar:1190, bat:null, batType:'Lithium 12kWh bank', bms:'Yes', water:null, len:null, tare:2560, atm:null, features:['12kWh lithium bank','1190W solar','Full ensuite','Flagship model'], mav:'Falcon 21DL' },
    ]},
    { name:'Stoney Creek Campers', website:'https://stoneycreekcampers.com.au', description:'Australian manufacturer known for Scout off-road caravans and SC-FF camper trailers. 2025 Gen 3 launch with composite FRP foam-sandwich panels. Offer Airbagman air suspension as standard.', sort:4, models:[
      { name:'Scout-17 Gen3 Off-Road', cat:'Off-Road Caravan', price:'$64,990', solar:600, bat:null, batType:'Lithium', bms:'Yes', water:null, len:17, tare:2791, atm:null, features:['Gen 3 composite FRP foam-sandwich panels','Airbagman air suspension — adjustable','Separate ensuite','Independent trailing arm suspension'], mav:'Falcon 17DL' },
      { name:'Scout-19 Off-Road', cat:'Off-Road Caravan', price:'$78,000', solar:null, bat:null, batType:'Lithium', bms:'Yes', water:null, len:19, tare:null, atm:null, features:['Gen 3 composite construction','Airbagman air suspension','Full ensuite','Luxury off-road specification'], mav:'Falcon 196' },
      { name:'SC-FF6 Camper Trailer', cat:'Off-Road Forward Fold Camper', price:null, solar:null, bat:200, batType:'AGM (2 x 100Ah)', bms:'Yes', water:140, len:null, tare:1700, atm:2200, features:['Sleeps 6','Heavy-duty independent suspension','200kg ball weight','Solar-ready (panels optional)','5400mm body length'], mav:'Falcon 146C' },
    ]},
    { name:'Jawa Caravans', website:'https://jawacampers.com.au', description:'Brisbane-based manufacturer. Multiple award winners including Caravan Trailer of the Year. Known for Victron/Enerdrive electrical systems, Lovells suspension, and 5-year structural warranty.', sort:5, models:[
      { name:'Infinity 15', cat:'Off-Road Hybrid Caravan', price:null, solar:600, bat:460, batType:'Lithium', bms:'Yes — Victron', water:240, len:15, tare:2470, atm:2990, features:['3000W Victron inverter','Folds to 18ft when set up','King bed + built-in bunks','Instantaneous hot water','270° batwing awning','Electric roof actuators','A/C + 24" smart TV','Twin 120L tanks + 80L grey'], mav:'Falcon 17DL' },
      { name:'Sirocco Grande', cat:'Off-Road Hybrid Pop-Top', price:'$76,000', solar:600, bat:400, batType:'Lithium', bms:'Yes — Enerdrive', water:240, len:15, tare:2430, atm:2990, features:['Enerdrive charging system','Electric pop-top roof','Caravan World Hybrid of the Year 2020','Full ensuite','A/C included in tare','Twin 120L tanks + 80L grey'], mav:'Viper 16DL' },
      { name:'Stealth 16', cat:'Off-Road Pop-Top Hybrid', price:null, solar:600, bat:400, batType:'Lithium — 2x200Ah Enerdrive', bms:'Yes — Enerdrive', water:240, len:16, tare:null, atm:null, features:['Eberspacher diesel heater','Webasto reverse cycle A/C','95L dual-zone fridge','Electric roof actuators','Lovells suspension','King bed + ensuite','Twin 120L tanks + 80L grey'], mav:'Falcon 17C' },
    ]},
    { name:'Eagle Camper Trailers', website:'https://eaglecampertrailers.com.au', description:'Australian-owned off-road caravan and camper trailer brand with showrooms in Adelaide, Perth, and Victoria. Warrior range is their flagship off-road hybrid line.', sort:6, models:[
      { name:'Warrior 15 Off-Road Hybrid', cat:'Off-Road Hybrid Caravan', price:null, solar:300, bat:300, batType:'AGM (3 x 100Ah)', bms:'Yes', water:120, len:15, tare:2340, atm:2900, features:['Heavy-duty independent suspension','McHitch off-road coupling','Al checker plate body','Gas/electric hot water','265/75R16 off-road tyres','16" alloy wheels','85L + 35L fresh water'], mav:'Viper 16DL' },
      { name:'Warrior 13 Off-Road Hybrid', cat:'Off-Road Hybrid Caravan', price:'$61,990', solar:300, bat:300, batType:'AGM (3 x 100Ah)', bms:'Yes', water:null, len:13, tare:null, atm:null, features:['Heavy-duty independent suspension','McHitch off-road coupling','Gas/electric hot water','Off-road tyres','Compact 13ft design'], mav:'Viper 13' },
    ]},
    { name:'Signature Camper Trailers', website:'https://signaturecampertrailers.com.au', description:'100% Australian-owned brand founded 2019, one of Australia\'s fastest-growing camper brands. 4-state showroom network. Uses REDARC and Enerdrive systems. 5-year structural warranty.', sort:7, models:[
      { name:'Iridium 15 GEN II Hybrid', cat:'Off-Road Hybrid Camper', price:null, solar:540, bat:200, batType:'Lithium — Enerdrive B-TEC', bms:'Yes — Enerdrive/REDARC', water:200, len:15, tare:2260, atm:2850, features:['3x180W REDARC solar panels','Webasto reverse cycle A/C','Hot-dip galvanised chassis','McHitch Uniglide 360° coupling','Independent off-road suspension','5-year structural warranty'], mav:'Viper 16C' },
      { name:'Marlu Hybrid', cat:'Off-Road Hybrid Caravan', price:null, solar:720, bat:200, batType:'Lithium — Enerdrive B-TEC Gen2 (upgradeable to 600Ah)', bms:'Yes — Enerdrive/REDARC', water:240, len:null, tare:2300, atm:3000, features:['4x180W REDARC monocrystalline solar','200Ah Enerdrive Gen2 (up to 600Ah optional)','Rapid setup and packdown','5-year structural warranty'], mav:'Viper 16DL' },
    ]},
    { name:'Mars Campers', website:'https://marscampers.com.au', description:"Victoria-based manufacturer known as 'Australia's best-value hybrid caravans'. Pop-top hybrid range from 11ft to 22ft. Uses Projecta battery management systems with strong standard inclusions at competitive prices.", sort:8, models:[
      { name:'Mars 15 Premium MKII', cat:'Pop-Top Hybrid Caravan', price:'$60,000', solar:600, bat:400, batType:'Lithium — 2x200Ah', bms:'Yes — Projecta PM400', water:240, len:15, tare:null, atm:3000, features:['Projecta PM400 power management','2000W Enerdrive inverter','30A mains charger','King size inner spring bed','External + internal kitchen','4.5m awning with walls + floor','Twin 120L tanks + 75L grey'], mav:'Viper 16DL' },
      { name:'Venus 17HR Off-Road', cat:'Off-Road Hard Top Hybrid', price:'$71,999', solar:600, bat:null, batType:'Projecta PM435 BMS', bms:'Yes — Projecta PM435', water:240, len:17, tare:2600, atm:3050, features:['Projecta PM435 BMS','Twin 120L fresh water tanks','Full hard-top off-road construction','Independent suspension'], mav:'Falcon 17DL' },
    ]},
    { name:'Arctic Campers', website:'https://arcticcampers.com.au', description:'Australian off-road hybrid caravan brand. Frost 13, Glacier 14 and 16 range of pop-top and hard-top hybrid caravans. Projecta PM400/PM435 power management standard across range.', sort:9, models:[
      { name:'Frost 13 Off-Road Hybrid', cat:'Off-Road Hybrid Caravan', price:'$56,990', solar:400, bat:270, batType:'LiFePO4 — 2x135Ah', bms:'Yes — Projecta PM400 with Bluetooth', water:240, len:13, tare:2100, atm:2990, features:['Projecta PM400 Bluetooth control','2000W inverter','Truma 14L hot water','Twin 120L tanks + 75L grey','12-inch electric brakes'], mav:'Viper 13' },
      { name:'Glacier 14 (2026)', cat:'Off-Road Hybrid Caravan', price:null, solar:400, bat:270, batType:'Lithium — Projecta PM400', bms:'Yes — Projecta PM400', water:240, len:14, tare:null, atm:null, features:['Truma Ultra Rapid 14L hot water','Twin 120L tanks + 75L grey','Independent suspension'], mav:'Viper 16C' },
      { name:'Glacier 16 Double Bunk', cat:'Off-Road Hybrid Caravan — Family', price:'$56,990', solar:600, bat:400, batType:'Lithium', bms:'Yes', water:240, len:16, tare:2490, atm:2990, features:['Double bunk family layout','600W solar + 400Ah lithium','External galley kitchen','Internal combo ensuite','16-inch mud tyres','Independent suspension'], mav:'Viper 16DL' },
    ]},
    { name:'Union RV', website:'https://unionrv.com.au', description:'Australian hybrid caravan brand offering pop-top and hard-top models. Uses Renogy solar and inverter systems with lithium batteries across range. Models cater to couples and families, with upgrade paths available.', sort:10, models:[
      { name:'Venture 15S Pop-Top Hybrid', cat:'Pop-Top Hybrid Caravan', price:null, solar:600, bat:270, batType:'Lithium — 2x135Ah (upgradeable to 405Ah)', bms:'Yes — Renogy', water:null, len:15, tare:2300, atm:3000, features:['Renogy 2000W inverter','Side pop-out + electric pop-top','Upgradeable to 405Ah','220kg tow ball weight','Couple-focused layout'], mav:'Viper 16C' },
      { name:'Tourer 16HT Hard-Top Hybrid', cat:'Hard-Top Hybrid Caravan', price:null, solar:600, bat:270, batType:'Lithium — 2x135Ah', bms:'Yes — Renogy', water:200, len:16, tare:2360, atm:3000, features:['Renogy 2000W inverter','Full ensuite + separate shower','Plumbed toilet','Washing machine','Hard-top off-road construction','228kg tow ball weight'], mav:'Falcon 17C' },
      { name:'Tourer 18HT3 Hard-Top Family', cat:'Hard-Top Hybrid Caravan — Family', price:null, solar:800, bat:270, batType:'Lithium — 2x135Ah', bms:'Yes — Renogy', water:200, len:18, tare:null, atm:null, features:['Renogy 2000W inverter','800W solar','Reverse cycle heating/cooling','175L fridge/freezer','Triple bunk family layout','Full ensuite'], mav:'Falcon 196' },
    ]},
  ];

  const seedTx = db.transaction(() => {
    seedData.forEach(c => {
      const comp = insertComp.run(c.name, c.website, c.description, c.sort);
      c.models.forEach(m => insertModel.run(comp.lastInsertRowid, m.name, m.cat, m.price||null, m.solar||null, m.bat||null, m.batType||null, m.bms||null, m.water||null, m.len||null, m.tare||null, m.atm||null, JSON.stringify(m.features), m.mav||null, m.ensuite||null));
    });
  });
  seedTx();
  console.log('Competitor data seeded');
}

httpServer.listen(PORT,'0.0.0.0',()=>console.log('Maverick Hub running on port '+PORT));
