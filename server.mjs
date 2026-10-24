import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { dateToISO } from "./datetime.mjs";

const scrypt = promisify(scryptCallback);
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_ROOM_IMAGE_BYTES = 5 * 1024 * 1024;
const HASH_LENGTH = 64;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 12;
const ROLES = new Set(["Administrateur", "Gestionnaire", "Utilisateur"]);
const PAYMENT_METHODS = new Set([
  "À payer",
  "M-Pesa",
  "Airtel Money",
  "Orange Money",
  "Paiement bancaire",
]);
const PAYMENT_STATUSES = new Set([
  "Non demandé",
  "En attente",
  "Payé",
  "Échoué",
  "Remboursé",
]);
const EVENT_TYPES = new Set([
  "Réunion",
  "Formation",
  "Conférence",
  "Entretien",
  "Mariage",
  "Salle mortuaire",
  "Anniversaire",
  "Autre",
]);
const LEGACY_ROOM_IMAGE_KEYS = ["meeting", "training", "conference", "interview", "creative"];
const ROOM_GALLERY_IMAGES = [
  "hall-classic",
  "classroom",
  "hall-lodge",
  "auditorium",
  "boardroom",
  "meeting-centara",
  "council-room",
];
const BANNER_IMAGES = Array.from({ length: 7 }, (_, index) => `assets/rooms/banner/slide-${index + 1}.jpg`);
const ROOM_IMAGE_KEYS = new Set([...LEGACY_ROOM_IMAGE_KEYS, ...ROOM_GALLERY_IMAGES]);
const ROOM_UPLOAD_DIRECTORY = resolve(ROOT, process.env.ROOMFLOW_DATA_DIR || "data", "room-images");
const ROOM_UPLOAD_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const PUBLIC_FILES = new Set([
  "index.html",
  "styles.css",
  "script.js",
  "datetime.mjs",
  "assets/brand-logo.png",
  "assets/rooms/gallery/Download google mail gmail icon logo symbol.jpg",
  "assets/rooms/gallery/TikTok.jpg",
  "assets/rooms/gallery/x icon.jpg",
  "assets/rooms/gallery/Square linkedin logo isolated on white background _ Premium Vector.jpg",
  "assets/rooms/gallery/Facebook logo.jpg",
  ...BANNER_IMAGES,
  ...LEGACY_ROOM_IMAGE_KEYS.map((key) => `assets/rooms/${key}.svg`),
  ...ROOM_GALLERY_IMAGES.map((key) => `assets/rooms/gallery/${key}.jpg`),
]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

if (PRODUCTION && !process.env.APP_ORIGIN) {
  throw new Error("APP_ORIGIN doit être configuré en production (ex. https://reservations.exemple.fr).");
}

const dataDirectory = resolve(ROOT, process.env.ROOMFLOW_DATA_DIR || "data");
mkdirSync(dataDirectory, { recursive: true });
const databasePath = resolve(dataDirectory, process.env.ROOMFLOW_DB_PATH || "roomflow.sqlite");
mkdirSync(ROOM_UPLOAD_DIRECTORY, { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK(role IN ('Administrateur', 'Gestionnaire', 'Utilisateur')),
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_hash TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    type TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK(capacity > 0),
    equipment TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    max_duration INTEGER NOT NULL CHECK(max_duration > 0 AND max_duration <= 12),
    image_key TEXT NOT NULL DEFAULT 'meeting',
    image_keys TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS organization_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    physical_address TEXT NOT NULL DEFAULT '',
    reference_details TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    owner_name TEXT NOT NULL,
    title TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'Réunion',
    booking_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    guests INTEGER NOT NULL CHECK(guests > 0),
    comment TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('en attente', 'confirmé', 'refusé', 'annulé')),
    payment_method TEXT NOT NULL DEFAULT 'À payer',
    payment_status TEXT NOT NULL DEFAULT 'Non demandé',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CDF',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reservations_room_date_idx ON reservations(room_id, booking_date, status);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);
`);

const reservationColumns = database.prepare("PRAGMA table_info(reservations)").all();
if (!reservationColumns.some((column) => column.name === "event_type")) {
  database.exec("ALTER TABLE reservations ADD COLUMN event_type TEXT NOT NULL DEFAULT 'Réunion'");
}
if (!reservationColumns.some((column) => column.name === "payment_method")) {
  database.exec("ALTER TABLE reservations ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'À payer'");
}
if (!reservationColumns.some((column) => column.name === "payment_status")) {
  database.exec("ALTER TABLE reservations ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'Non demandé'");
}
if (!reservationColumns.some((column) => column.name === "amount")) {
  database.exec("ALTER TABLE reservations ADD COLUMN amount REAL NOT NULL DEFAULT 0");
}
if (!reservationColumns.some((column) => column.name === "currency")) {
  database.exec("ALTER TABLE reservations ADD COLUMN currency TEXT NOT NULL DEFAULT 'CDF'");
}

const roomColumns = database.prepare("PRAGMA table_info(rooms)").all();
database.prepare("UPDATE rooms SET type=? WHERE type=?").run("Salle mortuaire", "Veillée mortuaire");
database.prepare("UPDATE reservations SET event_type=? WHERE event_type=?").run("Salle mortuaire", "Veillée mortuaire");
if (!roomColumns.some((column) => column.name === "image_key")) {
  database.exec("ALTER TABLE rooms ADD COLUMN image_key TEXT NOT NULL DEFAULT 'meeting'");
}

if (!roomColumns.some((column) => column.name === "image_keys")) {
  database.exec("ALTER TABLE rooms ADD COLUMN image_keys TEXT NOT NULL DEFAULT '[]'");
  const defaultGalleryByType = {
    "Réunion": ["boardroom", "council-room", "meeting-centara"],
    "Formation": ["classroom", "auditorium"],
    "Entretien": ["hall-lodge", "hall-classic"],
    "Conférence": ["hall-classic", "boardroom"],
    "Autre": ["meeting-centara", "council-room"],
  };
  const legacyRows = database.prepare("SELECT id, type, image_key FROM rooms").all();
  const updateGallery = database.prepare("UPDATE rooms SET image_key=?, image_keys=? WHERE id=?");
  for (const room of legacyRows) {
    const gallery = ROOM_GALLERY_IMAGES.includes(room.image_key)
      ? [room.image_key]
      : defaultGalleryByType[room.type] || ["hall-classic"];
    updateGallery.run(gallery[0], JSON.stringify(gallery), room.id);
  }
}
if (!roomColumns.some((column) => column.name === "physical_address")) {
  database.exec("ALTER TABLE rooms ADD COLUMN physical_address TEXT NOT NULL DEFAULT ''");
}
if (!roomColumns.some((column) => column.name === "reference_details")) {
  database.exec("ALTER TABLE rooms ADD COLUMN reference_details TEXT NOT NULL DEFAULT ''");
}
database.prepare("INSERT OR IGNORE INTO organization_settings (id) VALUES (1)").run();

if (database.prepare("SELECT COUNT(*) AS count FROM rooms").get().count === 0) {
  const seedRoom = database.prepare(`
    INSERT INTO rooms (name, code, type, capacity, equipment, location, active, open_time, close_time, max_duration, image_key, image_keys)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rooms = [
    ["Salle Atlas", "SAL-01", "Réunion", 12, "Écran, tableau, Wi-Fi", "Bâtiment A · 1er étage", 1, "08:00", "20:00", 4, "boardroom", '["boardroom","council-room","meeting-centara"]'],
    ["Salle Horizon", "SAL-02", "Formation", 20, "Écran, visioconférence", "Bâtiment A · 2e étage", 1, "08:00", "20:00", 6, "classroom", '["classroom","auditorium"]'],
    ["Salle Rivage", "SAL-03", "Entretien", 6, "Tableau, Wi-Fi", "Bâtiment B · RDC", 1, "09:00", "18:00", 3, "hall-lodge", '["hall-lodge","hall-classic"]'],
    ["Salle Érable", "SAL-04", "Conférence", 30, "Écran 4K, visioconférence", "Bâtiment C · 1er étage", 0, "08:00", "20:00", 8, "hall-classic", '["hall-classic","boardroom"]'],
  ];
  for (const room of rooms) seedRoom.run(...room);
}

const authAttempts = new Map();
const fakeSalt = randomBytes(16).toString("base64");
const fakeHash = await scrypt(randomBytes(32), Buffer.from(fakeSalt, "base64"), HASH_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function cookiesFromHeader(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function getRequestOrigin(request) {
  return process.env.APP_ORIGIN || `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (origin && origin !== getRequestOrigin(request)) {
    throw new HttpError(403, "Origine de requête non autorisée.");
  }
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      reject(new HttpError(415, "Le contenu doit être au format JSON."));
      request.resume();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "La requête est trop volumineuse."));
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Le corps JSON est invalide."));
      }
    });
    request.on("error", reject);
  });
}

function readRoomImage(request, extension) {
  return new Promise((resolveImage, reject) => {
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > MAX_ROOM_IMAGE_BYTES) {
      reject(new HttpError(413, "Chaque photo doit peser 5 Mo maximum."));
      request.resume();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_ROOM_IMAGE_BYTES) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "Chaque photo doit peser 5 Mo maximum."));
        return;
      }
      const image = Buffer.concat(chunks);
      const validSignature = extension === "jpg"
        ? image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
        : extension === "png"
          ? image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          : image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
      if (!validSignature) {
        reject(new HttpError(400, "Le fichier ne correspond pas à une image JPEG, PNG ou WebP valide."));
        return;
      }
      resolveImage(image);
    });
    request.on("error", reject);
  });
}

function isUploadedRoomImageKey(key) {
  return typeof key === "string" &&
    /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(key);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getUserBySession(request) {
  const token = cookiesFromHeader(request.headers.cookie).roomflow_session;
  if (!token || token.length > 128) throw new HttpError(401, "Connexion requise.");
  const session = database.prepare(`
    SELECT s.token_hash, s.csrf_hash, s.expires_at, u.id, u.name, u.email, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!session || session.expires_at <= Date.now() || !session.active) {
    if (session) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
    throw new HttpError(401, "Votre session a expiré. Veuillez vous reconnecter.");
  }
  return { session, user: { id: session.id, name: session.name, email: session.email, role: session.role } };
}

function requireCsrf(request, session) {
  const csrfToken = request.headers["x-csrf-token"];
  if (!csrfToken || typeof csrfToken !== "string" || !timingSafeEqual(Buffer.from(hashToken(csrfToken)), Buffer.from(session.csrf_hash))) {
    throw new HttpError(403, "Jeton de sécurité invalide. Actualisez la page et réessayez.");
  }
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, "Vous n’avez pas les droits nécessaires.");
}

function transaction(callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function audit(user, action, detail) {
  database.prepare(`
    INSERT INTO audit_log (user_id, actor_name, actor_role, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, user.name, user.role, action, detail, nowIso());
}

function notify(userId, title, message) {
  database.prepare(`
    INSERT INTO notifications (user_id, title, message, created_at) VALUES (?, ?, ?, ?)
  `).run(userId, title, message, nowIso());
}

function cleanString(value, name, maxLength, required = true) {
  if (typeof value !== "string") throw new HttpError(400, `${name} est invalide.`);
  const clean = value.trim();
  if (required && !clean) throw new HttpError(400, `${name} est obligatoire.`);
  if (clean.length > maxLength) throw new HttpError(400, `${name} dépasse ${maxLength} caractères.`);
  return clean;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateRoomInput(input) {
  const name = cleanString(input.name, "Le nom", 60);
  const code = cleanString(input.code, "Le code", 20);
  const type = cleanString(input.type || "Autre", "Le type", 40);
  const equipment = cleanString(input.equipment || "", "Les équipements", 160, false);
  const location = cleanString(input.location || "", "La localisation", 80, false);
  const physicalAddress = cleanString(input.physicalAddress || "", "L’adresse physique", 200, false);
  const referenceDetails = cleanString(input.referenceDetails || "", "Les références de la salle", 240, false);
  const open = cleanString(input.open, "L’heure d’ouverture", 5);
  const close = cleanString(input.close, "L’heure de fermeture", 5);
  const capacity = Number(input.capacity);
  const maxDuration = Number(input.maxDuration);
  let imageKeys;
  if (input.imageKeys === undefined) {
    const imageKey = input.imageKey === undefined ? "meeting" : input.imageKey;
    if (typeof imageKey !== "string" || !ROOM_IMAGE_KEYS.has(imageKey)) {
      throw new HttpError(400, "L’image choisie pour la salle est invalide.");
    }
    const legacyGalleryByImageKey = {
      meeting: ["boardroom", "council-room"],
      training: ["classroom", "auditorium"],
      conference: ["hall-classic", "meeting-centara"],
      interview: ["hall-lodge", "meeting-centara"],
      creative: ["meeting-centara", "council-room"],
    };
    imageKeys = ROOM_GALLERY_IMAGES.includes(imageKey) ? [imageKey] : legacyGalleryByImageKey[imageKey];
  } else {
    imageKeys = input.imageKeys;
    if (!Array.isArray(imageKeys) || imageKeys.length < 1 || imageKeys.length > ROOM_GALLERY_IMAGES.length ||
        imageKeys.some((key) => !ROOM_GALLERY_IMAGES.includes(key) &&
          (!isUploadedRoomImageKey(key) || !existsSync(resolve(ROOM_UPLOAD_DIRECTORY, key)))) ||
        new Set(imageKeys).size !== imageKeys.length) {
      throw new HttpError(400, `Choisissez entre 1 et ${ROOM_GALLERY_IMAGES.length} photos valides pour la galerie.`);
    }
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(open) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(close) || open >= close) {
    throw new HttpError(400, "La plage horaire de la salle est invalide.");
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new HttpError(400, "La capacité doit être comprise entre 1 et 500.");
  if (!Number.isInteger(maxDuration) || maxDuration < 1 || maxDuration > 12) throw new HttpError(400, "La durée maximale doit être comprise entre 1 et 12 heures.");
  if (typeof input.active !== "boolean") throw new HttpError(400, "Le statut de la salle est invalide.");
  return {
    name, code, type, capacity, equipment, location, physicalAddress, referenceDetails, open, close, maxDuration,
    imageKey: imageKeys[0], imageKeys, active: input.active ? 1 : 0,
  };
}

function mapRoom(row) {
  const imageKeys = JSON.parse(row.image_keys || "[]");
  return {
    id: row.id, name: row.name, code: row.code, type: row.type, capacity: row.capacity,
    equipment: row.equipment, location: row.location, physicalAddress: row.physical_address || "",
    referenceDetails: row.reference_details || "", active: Boolean(row.active),
    open: row.open_time, close: row.close_time, maxDuration: row.max_duration,
    imageKey: row.image_key, imageKeys,
  };
}

function mapOrganizationSettings(row) {
  return {
    physicalAddress: row.physical_address || "",
    referenceDetails: row.reference_details || "",
  };
}

function mapReservation(row) {
  const createdYear = dateToISO(new Date(row.created_at)).slice(0, 4);
  return {
    id: row.id, roomId: row.room_id, ownerId: row.user_id, owner: row.owner_name,
    title: row.title, eventType: row.event_type || "Réunion", date: row.booking_date, start: row.start_time, end: row.end_time,
    guests: row.guests, comment: row.comment, status: row.status,
    ticketNumber: `RF-${createdYear}-${String(row.id).padStart(6, "0")}`,
    paymentMethod: row.payment_method || "À payer",
    paymentStatus: row.payment_status || "Non demandé",
    amount: Number(row.amount || 0),
    currency: row.currency || "CDF",
  };
}

function mapReservationForUser(row, user) {
  const reservation = mapReservation(row);
  if (["Administrateur", "Gestionnaire"].includes(user.role) || reservation.ownerId === user.id) return reservation;
  const publicReservation = { ...reservation };
  delete publicReservation.ticketNumber;
  return {
    ...publicReservation,
    title: "Réservation occupée",
    eventType: "Réservation occupée",
    owner: "—",
    guests: 0,
    comment: "",
    ownerId: null,
  };
}

function roomIsBooked(roomId) {
  return Boolean(database.prepare(`
    SELECT 1 AS booked FROM reservations
    WHERE room_id = ? AND status IN ('en attente', 'confirmé') AND booking_date >= ?
    LIMIT 1
  `).get(roomId, dateToISO()));
}

function validateReservationInput(input, user, exceptId = null) {
  const roomId = Number(input.roomId);
  const roomRow = database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  if (!roomRow || !roomRow.active) throw new HttpError(400, "Cette salle est inactive ou n’existe plus.");
  const date = input.date;
  const start = input.start;
  const end = input.end;
  const title = cleanString(input.title, "L’objet", 100);
  const eventType = cleanString(input.eventType === undefined ? "Réunion" : input.eventType, "Le type d’événement", 40);
  if (!EVENT_TYPES.has(eventType)) throw new HttpError(400, "Le type d’événement est invalide.");
  const comment = cleanString(input.comment || "", "Le commentaire", 300, false);
  const guests = Number(input.guests);
  const paymentMethod = cleanString(input.paymentMethod === undefined ? "À payer" : input.paymentMethod, "Le mode de paiement", 40);
  if (!PAYMENT_METHODS.has(paymentMethod)) throw new HttpError(400, "Le mode de paiement est invalide.");
  const paymentStatus = cleanString(input.paymentStatus === undefined ? "Non demandé" : input.paymentStatus, "Le statut de paiement", 20);
  if (!PAYMENT_STATUSES.has(paymentStatus)) throw new HttpError(400, "Le statut de paiement est invalide.");
  const amount = Number(input.amount ?? 0);
  const currency = cleanString(input.currency === undefined ? "CDF" : input.currency, "La devise", 8);
  if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, "Le montant du paiement est invalide.");
  if (!validDate(date) || date < dateToISO()) throw new HttpError(400, "La date doit être aujourd’hui ou ultérieure.");
  if (typeof start !== "string" || typeof end !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
    throw new HttpError(400, "La plage horaire est invalide.");
  }
  if (start < roomRow.open_time || end > roomRow.close_time) throw new HttpError(400, `Les réservations de cette salle sont autorisées de ${roomRow.open_time} à ${roomRow.close_time}.`);
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  if (minutes(end) - minutes(start) > roomRow.max_duration * 60) throw new HttpError(400, `La durée maximale autorisée est de ${roomRow.max_duration} h.`);
  if (!Number.isInteger(guests) || guests < 1 || guests > roomRow.capacity) throw new HttpError(400, `Le nombre de participants doit être compris entre 1 et ${roomRow.capacity}.`);
  const conflict = database.prepare(`
    SELECT 1 AS conflict FROM reservations
    WHERE room_id = ? AND booking_date = ? AND status IN ('en attente', 'confirmé')
      AND start_time < ? AND end_time > ? AND (? IS NULL OR id != ?)
    LIMIT 1
  `).get(roomId, date, end, start, exceptId, exceptId);
  if (conflict) throw new HttpError(409, "Conflit : cette salle est déjà réservée sur cette plage horaire.");
  return { roomId, date, start, end, title, eventType, comment, guests, ownerName: user.name, paymentMethod, paymentStatus, amount, currency };
}

function createSession(response, user) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  database.prepare(`
    INSERT INTO sessions (token_hash, csrf_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), hashToken(csrf), user.id, expiresAt, nowIso());
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  const secure = PRODUCTION ? "; Secure" : "";
  response.setHeader("Set-Cookie", [
    `roomflow_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
    `roomflow_csrf=${csrf}; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  ]);
  return { user, csrfToken: csrf, expiresAt: new Date(expiresAt).toISOString() };
}

function clearSessionCookie(response) {
  const secure = PRODUCTION ? "; Secure" : "";
  response.setHeader("Set-Cookie", [
    `roomflow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
    `roomflow_csrf=; SameSite=Strict; Path=/; Max-Age=0${secure}`,
  ]);
}

function addSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (PRODUCTION) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

function authRateLimitKeys(request, email) {
  const address = request.socket.remoteAddress || "unknown";
  return { ipKey: `ip:${address}`, accountKey: `account:${address}:${email.toLowerCase()}` };
}

function checkLoginRateLimit(request, email) {
  const now = Date.now();
  const { ipKey, accountKey } = authRateLimitKeys(request, email);
  for (const key of [ipKey, accountKey]) {
    const bucket = authAttempts.get(key);
    if (bucket && bucket.resetAt <= now) authAttempts.delete(key);
  }
  const ipBucket = authAttempts.get(ipKey);
  const accountBucket = authAttempts.get(accountKey);
  if ((ipBucket && ipBucket.count >= 30) || (accountBucket && accountBucket.count >= 5)) {
    throw new HttpError(429, "Trop de tentatives. Réessayez dans quelques minutes.");
  }
}

function recordLoginAttempt(request, email, succeeded) {
  const { ipKey, accountKey } = authRateLimitKeys(request, email);
  if (succeeded) {
    authAttempts.delete(accountKey);
    return;
  }
  const now = Date.now();
  for (const key of [ipKey, accountKey]) {
    const bucket = authAttempts.get(key);
    if (!bucket || bucket.resetAt <= now) authAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    else bucket.count += 1;
  }
  if (authAttempts.size > 10_000) {
    for (const [storedKey, storedValue] of authAttempts) {
      if (storedValue.resetAt <= now) authAttempts.delete(storedKey);
    }
  }
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;

  if (pathname === "/api/auth/status" && method === "GET") {
    sendJson(response, 200, {
      initialSetupRequired: database.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0,
    });
    return;
  }

  const roomImageMatch = pathname.match(/^\/api\/room-images\/(upload-[0-9a-f-]{36}\.(?:jpg|png|webp))$/);
  if (roomImageMatch && method === "GET") {
    getUserBySession(request);
    const imagePath = resolve(ROOM_UPLOAD_DIRECTORY, roomImageMatch[1]);
    if (!isUploadedRoomImageKey(roomImageMatch[1]) || !existsSync(imagePath)) throw new HttpError(404, "Photo introuvable.");
    const contentType = roomImageMatch[1].endsWith(".jpg") ? "image/jpeg" : roomImageMatch[1].endsWith(".png") ? "image/png" : "image/webp";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(imagePath).on("error", () => {
      if (!response.headersSent) sendError(response, 404, "Photo introuvable.");
      else response.destroy();
    }).pipe(response);
    return;
  }

  if (pathname === "/api/room-images" && method === "POST") {
    checkOrigin(request);
    const { session, user } = getUserBySession(request);
    requireCsrf(request, session);
    requireRole(user, "Administrateur", "Gestionnaire");
    const contentType = String(request.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
    const extension = ROOM_UPLOAD_EXTENSIONS.get(contentType);
    if (!extension) throw new HttpError(415, "Choisissez une photo au format JPEG, PNG ou WebP.");
    const image = await readRoomImage(request, extension);
    const key = `upload-${randomUUID()}.${extension}`;
    await writeFile(resolve(ROOM_UPLOAD_DIRECTORY, key), image, { flag: "wx" });
    sendJson(response, 201, { key });
    return;
  }

  if (roomImageMatch && method === "DELETE") {
    checkOrigin(request);
    const { session, user } = getUserBySession(request);
    requireCsrf(request, session);
    requireRole(user, "Administrateur", "Gestionnaire");
    const key = roomImageMatch[1];
    if (!isUploadedRoomImageKey(key)) throw new HttpError(404, "Photo introuvable.");
    const isUsed = database.prepare("SELECT image_keys FROM rooms").all()
      .some((room) => JSON.parse(room.image_keys || "[]").includes(key));
    if (isUsed) throw new HttpError(409, "Cette photo est utilisée par une salle.");
    const imagePath = resolve(ROOM_UPLOAD_DIRECTORY, key);
    if (!existsSync(imagePath)) throw new HttpError(404, "Photo introuvable.");
    await unlink(imagePath);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (["/api/auth/setup", "/api/auth/register"].includes(pathname) && method === "POST") {
    const initialSetup = pathname === "/api/auth/setup";
    const input = await readJson(request);
    checkOrigin(request);
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!initialSetup) {
      checkLoginRateLimit(request, `register:${email}`);
      recordLoginAttempt(request, `register:${email}`, false);
      if (!database.prepare("SELECT 1 FROM users LIMIT 1").get()) {
        throw new HttpError(409, "L’administrateur doit d’abord initialiser l’application.");
      }
    }
    const name = cleanString(input.name, "Le nom", 80);
    const password = input.password;
    validateEmailAndPassword(email, password);
    const salt = randomBytes(16);
    const passwordHash = await scrypt(password, salt, HASH_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    let user;
    try {
      user = transaction(() => {
        if (initialSetup && database.prepare("SELECT 1 FROM users LIMIT 1").get()) {
          throw new HttpError(409, "Le compte administrateur initial a déjà été créé. Connectez-vous ou contactez l’administrateur.");
        }
        const role = initialSetup ? "Administrateur" : "Utilisateur";
        const userId = Number(database.prepare(`
          INSERT INTO users (name, email, role, salt, password_hash, active, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(name, email, role, salt.toString("base64"), Buffer.from(passwordHash).toString("base64"), nowIso()).lastInsertRowid);
        return { id: userId, name, email, role };
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "Cette adresse e-mail est déjà utilisée. Connectez-vous ou contactez l’administrateur.");
      throw error;
    }
    const session = createSession(response, user);
    audit(user, initialSetup ? "Configuration initiale" : "Inscription", initialSetup ? "Premier compte administrateur créé" : "Compte Utilisateur créé");
    sendJson(response, 201, session);
    return;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const input = await readJson(request);
    checkOrigin(request);
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || password.length > 128) {
      throw new HttpError(400, "Adresse e-mail ou mot de passe invalide.");
    }
    checkLoginRateLimit(request, email);
    const account = database.prepare("SELECT id, name, email, role, salt, password_hash, active FROM users WHERE email = ?").get(email);
    const salt = account?.salt ? Buffer.from(account.salt, "base64") : Buffer.from(fakeSalt, "base64");
    const expected = account?.password_hash ? Buffer.from(account.password_hash, "base64") : fakeHash;
    const candidate = Buffer.from(await scrypt(password, salt, HASH_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
    const valid = candidate.length === expected.length && timingSafeEqual(candidate, expected) && Boolean(account?.active);
    recordLoginAttempt(request, email, valid);
    if (!valid) throw new HttpError(401, `Adresse e-mail ou mot de passe incorrect. Le mot de passe doit contenir entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères.`);
    const user = { id: account.id, name: account.name, email: account.email, role: account.role };
    const session = createSession(response, user);
    audit(user, "Connexion", "Session ouverte");
    sendJson(response, 200, session);
    return;
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    await readJson(request);
    checkOrigin(request);
    const { session, user } = getUserBySession(request);
    requireCsrf(request, session);
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
    audit(user, "Déconnexion", "Session fermée");
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const { session, user } = getUserBySession(request);
    let csrfToken = cookiesFromHeader(request.headers.cookie).roomflow_csrf;
    if (!csrfToken || !timingSafeEqual(Buffer.from(hashToken(csrfToken)), Buffer.from(session.csrf_hash))) {
      csrfToken = randomBytes(32).toString("base64url");
      database.prepare("UPDATE sessions SET csrf_hash = ? WHERE token_hash = ?").run(hashToken(csrfToken), session.token_hash);
      const secure = PRODUCTION ? "; Secure" : "";
      response.setHeader("Set-Cookie", `roomflow_csrf=${csrfToken}; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
    }
    sendJson(response, 200, {
      user,
      csrfToken,
      csrfRequired: true,
      sessionExpiresAt: new Date(session.expires_at).toISOString(),
    });
    return;
  }

  const auth = getUserBySession(request);
  const requestBody = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(request) : null;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    checkOrigin(request);
    requireCsrf(request, auth.session);
  }

  if (pathname === "/api/auth/password" && method === "POST") {
    const currentPassword = requestBody.currentPassword;
    const newPassword = requestBody.newPassword;
    validateEmailAndPassword(auth.user.email, newPassword);
    const account = database.prepare("SELECT salt, password_hash FROM users WHERE id=?").get(auth.user.id);
    const candidate = Buffer.from(await scrypt(
      typeof currentPassword === "string" ? currentPassword : "",
      Buffer.from(account.salt, "base64"),
      HASH_LENGTH,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    ));
    const expected = Buffer.from(account.password_hash, "base64");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new HttpError(401, "Le mot de passe actuel est incorrect.");
    }
    const salt = randomBytes(16);
    const passwordHash = await scrypt(newPassword, salt, HASH_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    database.prepare("UPDATE users SET salt=?, password_hash=? WHERE id=?").run(
      salt.toString("base64"), Buffer.from(passwordHash).toString("base64"), auth.user.id,
    );
    database.prepare("DELETE FROM sessions WHERE user_id=?").run(auth.user.id);
    const session = createSession(response, auth.user);
    audit(auth.user, "Mot de passe modifié", "Toutes les sessions précédentes ont été révoquées");
    sendJson(response, 200, session);
    return;
  }

  if (pathname === "/api/settings/organization" && method === "PUT") {
    requireRole(auth.user, "Administrateur");
    const physicalAddress = cleanString(requestBody.physicalAddress, "L’adresse physique de l’établissement", 200, false);
    const referenceDetails = cleanString(requestBody.referenceDetails, "Les références de l’établissement", 240, false);
    database.prepare(`
      UPDATE organization_settings SET physical_address=?, reference_details=? WHERE id=1
    `).run(physicalAddress, referenceDetails);
    audit(auth.user, "Coordonnées de l’établissement modifiées", "Adresse et références des tickets");
    const organization = mapOrganizationSettings(database.prepare("SELECT * FROM organization_settings WHERE id=1").get());
    sendJson(response, 200, { organization });
    return;
  }

  if (pathname === "/api/bootstrap" && method === "GET") {
    const rooms = database.prepare("SELECT * FROM rooms ORDER BY name").all().map(mapRoom);
    const organization = mapOrganizationSettings(database.prepare("SELECT * FROM organization_settings WHERE id=1").get());
    const reservations = database.prepare("SELECT * FROM reservations ORDER BY booking_date, start_time").all()
      .map((reservation) => mapReservationForUser(reservation, auth.user));
    const isAdmin = auth.user.role === "Administrateur";
    const notifications = isAdmin ? database.prepare(`
      SELECT id, title, message, created_at AS createdAt, read_at AS readAt
      FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50
    `).all(auth.user.id) : [];
    const unreadNotificationCount = isAdmin ? database.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL",
    ).get(auth.user.id).count : 0;
    const logs = isAdmin
      ? database.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100").all().map((entry) => ({
        id: entry.id, at: entry.created_at, action: entry.action, detail: entry.detail, role: entry.actor_role, actor: entry.actor_name,
      }))
      : [];
    sendJson(response, 200, { user: auth.user, rooms, organization, reservations, notifications, unreadNotificationCount, logs });
    return;
  }

  if (pathname === "/api/notifications/read-all" && method === "POST") {
    requireRole(auth.user, "Administrateur");
    database.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL").run(nowIso(), auth.user.id);
    sendJson(response, 200, { ok: true });
    return;
  }
  const notificationMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (notificationMatch && method === "POST") {
    requireRole(auth.user, "Administrateur");
    const result = database.prepare(`
      UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL
    `).run(nowIso(), Number(notificationMatch[1]), auth.user.id);
    if (!result.changes) {
      const exists = database.prepare("SELECT 1 FROM notifications WHERE id=? AND user_id=?")
        .get(Number(notificationMatch[1]), auth.user.id);
      if (!exists) throw new HttpError(404, "Notification introuvable.");
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/rooms" && method === "POST") {
    requireRole(auth.user, "Administrateur", "Gestionnaire");
    const input = validateRoomInput(requestBody);
    let roomId;
    try {
      roomId = Number(database.prepare(`
        INSERT INTO rooms (name, code, type, capacity, equipment, location, physical_address, reference_details, active, open_time, close_time, max_duration, image_key, image_keys)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.name, input.code, input.type, input.capacity, input.equipment, input.location, input.physicalAddress, input.referenceDetails, input.active, input.open, input.close, input.maxDuration, input.imageKey, JSON.stringify(input.imageKeys)).lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "Une salle porte déjà ce nom ou ce code.");
      throw error;
    }
    audit(auth.user, "Salle créée", `${input.name} (${input.code})`);
    sendJson(response, 201, { room: mapRoom(database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId)) });
    return;
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/(\d+)(?:\/(active))?$/);
  if (roomMatch && method === "PUT") {
    requireRole(auth.user, "Administrateur", "Gestionnaire");
    const roomId = Number(roomMatch[1]);
    const input = validateRoomInput(requestBody);
    const existingRoom = database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!existingRoom) throw new HttpError(404, "Salle introuvable.");
    if (existingRoom.active && !input.active && roomIsBooked(roomId)) {
      throw new HttpError(409, "Cette salle a des réservations actives. Annulez-les avant de la désactiver.");
    }
    try {
      const result = database.prepare(`
        UPDATE rooms SET name=?, code=?, type=?, capacity=?, equipment=?, location=?, physical_address=?, reference_details=?, active=?, open_time=?, close_time=?, max_duration=?, image_key=?, image_keys=?
        WHERE id=?
      `).run(input.name, input.code, input.type, input.capacity, input.equipment, input.location, input.physicalAddress, input.referenceDetails, input.active, input.open, input.close, input.maxDuration, input.imageKey, JSON.stringify(input.imageKeys), roomId);
      if (!result.changes) throw new HttpError(404, "Salle introuvable.");
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "Une salle porte déjà ce nom ou ce code.");
      throw error;
    }
    audit(auth.user, "Salle modifiée", `${input.name} (${input.code})`);
    sendJson(response, 200, { room: mapRoom(database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId)) });
    return;
  }
  if (roomMatch && method === "PATCH" && roomMatch[2] === "active") {
    requireRole(auth.user, "Administrateur", "Gestionnaire");
    const roomId = Number(roomMatch[1]);
    const input = requestBody;
    if (typeof input.active !== "boolean") throw new HttpError(400, "Le statut de la salle est invalide.");
    const room = database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!room) throw new HttpError(404, "Salle introuvable.");
    if (!input.active && roomIsBooked(roomId)) throw new HttpError(409, "Cette salle a des réservations actives. Annulez-les avant de la désactiver.");
    database.prepare("UPDATE rooms SET active = ? WHERE id = ?").run(input.active ? 1 : 0, roomId);
    audit(auth.user, input.active ? "Salle activée" : "Salle désactivée", `${room.name} (${room.code})`);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (roomMatch && method === "DELETE" && !roomMatch[2]) {
    requireRole(auth.user, "Administrateur", "Gestionnaire");
    const roomId = Number(roomMatch[1]);
    const room = database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!room) throw new HttpError(404, "Salle introuvable.");
    if (database.prepare("SELECT 1 FROM reservations WHERE room_id = ? LIMIT 1").get(roomId)) {
      throw new HttpError(409, "Cette salle figure dans l’historique. Désactivez-la plutôt que de la supprimer.");
    }
    database.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    audit(auth.user, "Salle supprimée", `${room.name} (${room.code})`);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/reservations" && method === "POST") {
    const input = requestBody;
    const recurrence = input.recurrence || "none";
    const count = recurrence === "none" ? 1 : Number(input.occurrences);
    if (!["none", "hourly", "daily", "weekly", "monthly"].includes(recurrence) || !Number.isInteger(count) || count < 1 || count > 12) {
      throw new HttpError(400, "La règle de récurrence est invalide (1 à 12 séances).");
    }
    const interval = ["hourly", "daily"].includes(recurrence) ? Number(input.recurrenceInterval ?? 1) : 1;
    if (!Number.isSafeInteger(interval) || interval < 1) {
      throw new HttpError(400, "L’intervalle de récurrence doit être un nombre entier positif.");
    }
    validateReservationInput(input, auth.user);
    const requestedDate = input.date;
    const [year, month, day] = requestedDate.split("-").map(Number);
    const shiftedDate = (timestamp) => {
      const value = new Date(timestamp);
      if (!Number.isFinite(value.getTime()) || !validDate(value.toISOString().slice(0, 10))) {
        throw new HttpError(400, "L’intervalle produit une date de réservation invalide.");
      }
      return value;
    };
    const occurrences = Array.from({ length: count }, (_, index) => {
      if (recurrence === "hourly") {
        const start = shiftedDate(Date.parse(`${requestedDate}T${input.start}:00Z`) + index * interval * 3600000);
        const end = shiftedDate(Date.parse(`${requestedDate}T${input.end}:00Z`) + index * interval * 3600000);
        if (start.toISOString().slice(0, 10) !== end.toISOString().slice(0, 10)) {
          throw new HttpError(400, "Chaque séance doit se terminer le même jour que son début.");
        }
        return { date: start.toISOString().slice(0, 10), start: start.toISOString().slice(11, 16), end: end.toISOString().slice(11, 16) };
      }
      if (recurrence === "daily") return { date: shiftedDate(Date.UTC(year, month - 1, day + index * interval)).toISOString().slice(0, 10) };
      if (recurrence === "weekly") return { date: new Date(Date.UTC(year, month - 1, day + index * 7)).toISOString().slice(0, 10) };
      if (recurrence === "monthly") {
        const targetMonth = month - 1 + index;
        const targetYear = year + Math.floor(targetMonth / 12);
        const normalizedMonth = ((targetMonth % 12) + 12) % 12;
        const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
        return { date: new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10) };
      }
      return input;
    });
    const created = transaction(() => {
      const insert = database.prepare(`
        INSERT INTO reservations (room_id, user_id, owner_name, title, event_type, booking_date, start_time, end_time, guests, comment, status, payment_method, payment_status, amount, currency, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en attente', ?, ?, ?, ?, ?, ?)
      `);
      const reservations = occurrences.map((occurrence) => {
        const item = validateReservationInput({ ...input, ...occurrence }, auth.user);
        const now = nowIso();
        const id = Number(insert.run(
          item.roomId,
          auth.user.id,
          item.ownerName,
          item.title,
          item.eventType,
          item.date,
          item.start,
          item.end,
          item.guests,
          item.comment,
          item.paymentMethod,
          item.paymentStatus,
          item.amount,
          item.currency,
          now,
          now,
        ).lastInsertRowid);
        return mapReservation(database.prepare("SELECT * FROM reservations WHERE id = ?").get(id));
      });
      const roomName = database.prepare("SELECT name FROM rooms WHERE id=?").get(reservations[0].roomId).name;
      const sessionCount = reservations.length;
      const occurrenceText = sessionCount === 1 ? "" : ` (${sessionCount} séances récurrentes)`;
      notify(
        auth.user.id,
        "Demande envoyée",
        `Votre demande pour ${roomName}, le ${reservations[0].date} de ${reservations[0].start} à ${reservations[0].end}${occurrenceText}, a été transmise pour validation.`,
      );
      return reservations;
    });
    audit(auth.user, "Demande créée", `${created[0].title} · ${created.length} séance${created.length === 1 ? "" : "s"}`);
    sendJson(response, 201, { reservations: created });
    return;
  }

  const reservationMatch = pathname.match(/^\/api\/reservations\/(\d+)(?:\/(status|cancel))?$/);
  if (reservationMatch && method === "PUT" && !reservationMatch[2]) {
    const booking = database.prepare("SELECT * FROM reservations WHERE id = ?").get(Number(reservationMatch[1]));
    if (!booking) throw new HttpError(404, "Réservation introuvable.");
    if (booking.user_id !== auth.user.id && !["Administrateur", "Gestionnaire"].includes(auth.user.role)) throw new HttpError(403, "Vous ne pouvez modifier que vos propres réservations.");
    if (booking.booking_date < dateToISO() || !["confirmé", "en attente"].includes(booking.status)) {
      throw new HttpError(409, "Cette réservation est clôturée et ne peut plus être modifiée.");
    }
    const input = requestBody;
    const validated = validateReservationInput(input, auth.user, booking.id);
    transaction(() => {
      database.prepare(`
        UPDATE reservations SET room_id=?, title=?, event_type=?, booking_date=?, start_time=?, end_time=?, guests=?, comment=?, payment_method=?, payment_status=?, amount=?, currency=?, updated_at=? WHERE id=?
      `).run(validated.roomId, validated.title, validated.eventType, validated.date, validated.start, validated.end, validated.guests, validated.comment, validated.paymentMethod, validated.paymentStatus, validated.amount, validated.currency, nowIso(), booking.id);
      notify(booking.user_id, "Réservation modifiée", `La réservation « ${validated.title} » du ${validated.date} a été modifiée.`);
      audit(auth.user, "Réservation modifiée", `${validated.title} · ${validated.date}`);
    });
    sendJson(response, 200, { reservation: mapReservation(database.prepare("SELECT * FROM reservations WHERE id = ?").get(booking.id)) });
    return;
  }
  if (reservationMatch && method === "PATCH" && reservationMatch[2] === "status") {
    requireRole(auth.user, "Administrateur", "Gestionnaire");
    const booking = database.prepare("SELECT * FROM reservations WHERE id = ?").get(Number(reservationMatch[1]));
    if (!booking) throw new HttpError(404, "Réservation introuvable.");
    const input = requestBody;
    if (booking.status !== "en attente" || !["confirmé", "refusé"].includes(input.status)) throw new HttpError(409, "Cette demande ne peut plus être traitée.");
    if (input.status === "confirmé") validateReservationInput({
      roomId: booking.room_id, date: booking.booking_date, start: booking.start_time, end: booking.end_time,
      title: booking.title, eventType: booking.event_type, comment: booking.comment, guests: booking.guests,
    }, auth.user, booking.id);
    transaction(() => {
      database.prepare("UPDATE reservations SET status=?, updated_at=? WHERE id=?").run(input.status, nowIso(), booking.id);
      notify(
        booking.user_id,
        input.status === "confirmé" ? "Réservation confirmée" : "Demande refusée",
        `Votre réservation « ${booking.title} » du ${booking.booking_date} de ${booking.start_time} à ${booking.end_time} a été ${input.status === "confirmé" ? "confirmée" : "refusée"}.`,
      );
      audit(auth.user, input.status === "confirmé" ? "Réservation validée" : "Réservation refusée", `${booking.title} · ${booking.booking_date}`);
    });
    sendJson(response, 200, { ok: true });
    return;
  }
  if (reservationMatch && method === "POST" && reservationMatch[2] === "cancel") {
    const booking = database.prepare("SELECT * FROM reservations WHERE id = ?").get(Number(reservationMatch[1]));
    if (!booking) throw new HttpError(404, "Réservation introuvable.");
    if (booking.user_id !== auth.user.id && !["Administrateur", "Gestionnaire"].includes(auth.user.role)) throw new HttpError(403, "Vous ne pouvez annuler que vos propres réservations.");
    if (booking.booking_date < dateToISO() || !["confirmé", "en attente"].includes(booking.status)) {
      throw new HttpError(409, "Cette réservation ne peut plus être annulée.");
    }
    const input = requestBody;
    const reason = cleanString(input.reason || "", "Le motif", 300, false);
    const comment = [booking.comment, reason ? `Annulation : ${reason}` : ""].filter(Boolean).join(" · ");
    transaction(() => {
      database.prepare("UPDATE reservations SET status='annulé', comment=?, updated_at=? WHERE id=?").run(comment, nowIso(), booking.id);
      notify(booking.user_id, "Réservation annulée", `La réservation « ${booking.title} » du ${booking.booking_date} a été annulée${reason ? ` : ${reason}` : "."}`);
      audit(auth.user, "Réservation annulée", `${booking.title} · ${reason || "sans motif"}`);
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/users" && method === "GET") {
    requireRole(auth.user, "Administrateur");
    const users = database.prepare("SELECT id, name, email, role, active, created_at FROM users ORDER BY name").all()
      .map((user) => ({ ...user, active: Boolean(user.active) }));
    sendJson(response, 200, { users });
    return;
  }
  if (pathname === "/api/users" && method === "POST") {
    requireRole(auth.user, "Administrateur");
    const input = requestBody;
    const name = cleanString(input.name, "Le nom", 80);
    const email = cleanString(input.email, "L’adresse e-mail", 254).toLowerCase();
    const password = input.password;
    const role = input.role;
    validateEmailAndPassword(email, password);
    if (!ROLES.has(role)) throw new HttpError(400, "Le rôle est invalide.");
    const salt = randomBytes(16);
    const passwordHash = await scrypt(password, salt, HASH_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      const id = Number(database.prepare(`
        INSERT INTO users (name, email, role, salt, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(name, email, role, salt.toString("base64"), Buffer.from(passwordHash).toString("base64"), nowIso()).lastInsertRowid);
      audit(auth.user, "Compte créé", `${email} · ${role}`);
      sendJson(response, 201, { user: database.prepare("SELECT id, name, email, role, active, created_at FROM users WHERE id=?").get(id) });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "Cette adresse e-mail est déjà utilisée.");
      throw error;
    }
    return;
  }
  const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === "PATCH") {
    requireRole(auth.user, "Administrateur");
    const target = database.prepare("SELECT id, name, email, role, active FROM users WHERE id=?").get(Number(userMatch[1]));
    if (!target) throw new HttpError(404, "Compte introuvable.");
    const input = requestBody;
    if (input.role !== undefined && !ROLES.has(input.role)) throw new HttpError(400, "Le rôle est invalide.");
    if (input.active !== undefined && typeof input.active !== "boolean") throw new HttpError(400, "Le statut du compte est invalide.");
    const nextRole = input.role ?? target.role;
    const nextActive = input.active ?? Boolean(target.active);
    if (target.id === auth.user.id && (!nextActive || nextRole !== "Administrateur")) throw new HttpError(400, "Vous ne pouvez pas désactiver ou rétrograder votre propre compte.");
    if (target.role === "Administrateur" && target.active && (!nextActive || nextRole !== "Administrateur")) {
      const admins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role='Administrateur' AND active=1").get().count;
      if (admins <= 1) throw new HttpError(409, "Le dernier compte administrateur ne peut pas être désactivé ou rétrogradé.");
    }
    database.prepare("UPDATE users SET role=?, active=? WHERE id=?").run(nextRole, nextActive ? 1 : 0, target.id);
    if (!nextActive) database.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    audit(auth.user, "Compte modifié", `${target.email} · ${nextRole} · ${nextActive ? "actif" : "désactivé"}`);
    sendJson(response, 200, { ok: true });
    return;
  }

  throw new HttpError(404, "Ressource introuvable.");
}

function validateEmailAndPassword(email, password) {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(400, "Adresse e-mail invalide.");
  }
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, `Le mot de passe doit contenir entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères.`);
  }
}

async function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!PUBLIC_FILES.has(requestedPath)) throw new HttpError(404, "Fichier introuvable.");
  const filePath = resolve(ROOT, requestedPath);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) throw new HttpError(404, "Fichier introuvable.");
  if (extname(filePath) === ".sqlite" || requestedPath.startsWith("data/") || requestedPath.startsWith(".env")) {
    throw new HttpError(404, "Fichier introuvable.");
  }
  const mimeType = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).on("error", () => {
    if (!response.headersSent) sendError(response, 404, "Fichier introuvable.");
    else response.destroy();
  }).pipe(response);
}

async function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("La création du compte administrateur nécessite un terminal interactif.");
  return new Promise((resolvePrompt, reject) => {
    const stdin = process.stdin;
    let value = "";
    const wasRaw = stdin.isRaw;
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buffer) => {
      for (const character of buffer.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Création annulée."));
          return;
        }
        if (character === "\r" || character === "\n") {
          process.stdout.write("\n");
          cleanup();
          resolvePrompt(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw || false);
      stdin.pause();
    }
    stdin.on("data", onData);
  });
}

async function createAdminCli() {
  if (database.prepare("SELECT COUNT(*) AS count FROM users WHERE role='Administrateur'").get().count > 0) {
    throw new Error("Un compte administrateur existe déjà. Créez les comptes suivants depuis l’espace de gestion.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("La création du compte administrateur nécessite un terminal interactif. Ouvrez PowerShell, puis relancez npm run create-admin.");
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt) => new Promise((resolveQuestion) => input.question(prompt, resolveQuestion));
  let name;
  let email;
  try {
    name = (await question("Nom de l’administrateur : ")).trim();
    email = (await question("Adresse e-mail : ")).trim().toLowerCase();
  } finally {
    input.close();
  }
  validateEmailAndPassword(email, "x".repeat(PASSWORD_MIN_LENGTH));
  if (!name || name.length > 80) throw new Error("Le nom doit contenir entre 1 et 80 caractères.");
  const password = await promptHidden(`Mot de passe (entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères, saisie masquée) : `);
  const confirmation = await promptHidden("Confirmez le mot de passe : ");
  if (password !== confirmation) throw new Error("Les mots de passe ne correspondent pas.");
  validateEmailAndPassword(email, password);
  const salt = randomBytes(16);
  const passwordHash = await scrypt(password, salt, HASH_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  database.prepare(`
    INSERT INTO users (name, email, role, salt, password_hash, active, created_at) VALUES (?, ?, 'Administrateur', ?, ?, 1, ?)
  `).run(name, email, salt.toString("base64"), Buffer.from(passwordHash).toString("base64"), nowIso());
  console.log(`Compte administrateur créé pour ${email}.`);
}

if (process.argv[2] === "create-admin") {
  try {
    await createAdminCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    database.close();
  }
} else {
  const server = createServer(async (request, response) => {
    addSecurityHeaders(response);
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
      else if (request.method === "GET" || request.method === "HEAD") await serveStatic(request, response, url);
      else throw new HttpError(405, "Méthode non autorisée.");
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message);
        return;
      }
      console.error("Erreur serveur :", error);
      if (!response.headersSent) sendError(response, 500, "Une erreur interne est survenue.");
      else response.destroy();
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`RoomFlow disponible sur http://${HOST}:${PORT}`);
    console.log(`Base SQLite : ${databasePath}`);
    if (!database.prepare("SELECT 1 FROM users WHERE role='Administrateur' LIMIT 1").get()) {
      console.log("Initialisez le premier compte avec : npm run create-admin");
    }
  });

  const closeServer = () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", closeServer);
  process.on("SIGTERM", closeServer);
}
