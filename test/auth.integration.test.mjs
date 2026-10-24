import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = resolve(import.meta.dirname, "..");

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

test("session, CSRF, permissions, reservations and password rotation", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "roomflow-auth-test-"));
  const database = new DatabaseSync(join(dataDirectory, "roomflow.sqlite"));
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK(role IN ('Administrateur', 'Gestionnaire', 'Utilisateur')),
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL
    );
  `);
  const initialPassword = "Correct Horse Battery Staple 2026!";
  const adminSalt = randomBytes(16);
  const adminHash = scryptSync(initialPassword, adminSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  database.prepare(`
    INSERT INTO users (name,email,role,salt,password_hash,active,created_at)
    VALUES (?,?,'Administrateur',?,?,1,?)
  `).run("Test Admin", "admin@example.test", adminSalt.toString("base64"), adminHash.toString("base64"), new Date().toISOString());
  database.close();

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ROOMFLOW_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3000),
    ]);
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, `Server did not start. ${serverOutput}`);

  const call = async (path, { method = "GET", body, cookie = "", csrf = "", origin = baseUrl } = {}) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers["X-CSRF-Token"] = csrf;
    if (method !== "GET") headers.Origin = origin;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    return { response, payload };
  };
  const cookieFrom = (response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");

  const protectedResult = await call("/api/bootstrap");
  assert.equal(protectedResult.response.status, 401);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Bienvenue sur RoomFlow/);
  for (const id of ["setupPassword", "setupConfirmPassword", "newUserPassword", "newPassword", "confirmPassword"]) {
    assert.match(pageHtml, new RegExp(`id="${id}"[^>]*minlength="8" maxlength="12"`));
  }
  assert.doesNotMatch(pageHtml, /12 caractères minimum/);
  assert.doesNotMatch(pageHtml, /type="time"/);
  for (const id of ["startTime", "endTime", "newRoomOpen", "newRoomClose"]) {
    assert.match(pageHtml, new RegExp(`id="${id}" type="text"[^>]*pattern="\\(\\[01\\]\\[0-9\\]\\|2\\[0-3\\]\\):\\[0-5\\]\\[0-9\\]"`));
  }
  assert.match(pageHtml, /id="showLoginButton"[^>]*>Se connecter<\/button>/);
  assert.match(pageHtml, /id="showRegisterButton"[^>]*>Créer un compte<\/button>/);
  assert.doesNotMatch(pageHtml, /Connectez-vous avec votre compte administrateur/);
  for (const section of ["notificationsSection", "reportsSection"]) {
    assert.match(pageHtml, new RegExp(`<a class="nav-item admin-only hidden" href="#${section}"`));
    assert.match(pageHtml, new RegExp(`<section class="panel section-panel admin-only hidden" id="${section}"`));
  }
  assert.match(pageHtml, /src="\/assets\/brand-logo\.png"/);
  const footer = pageHtml.slice(pageHtml.indexOf("<footer"), pageHtml.indexOf("</footer>"));
  assert.ok(footer.includes("Tout droit reserver © 2026. RoomFlow By Michel Ngoyi"));
  assert.doesNotMatch(footer, /RoomFlow · Réservation de salles|Vos demandes et les actions sensibles sont gérées et journalisées par le serveur\./);
  for (const url of [
    "https://www.tiktok.com/@michelngoyikalend",
    "https://x.com/kalenda1497",
    "https://www.linkedin.com/in/michel-ngoyi-296ba4241",
    "https://www.facebook.com/michel.ngoyikalenda",
    "https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=michelngoyikalenda%40gmail.com",
    "https://wa.me/243851699229",
    "tel:+243851699229",
  ]) {
    assert.ok(footer.includes(`href="${url}"`), `Missing footer contact: ${url}`);
  }
  for (const link of [
    'href="https://wa.me/243851699229" target="_blank" rel="noopener noreferrer"',
    'href="https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=michelngoyikalenda%40gmail.com" target="_blank" rel="noopener noreferrer"',
    'href="https://www.tiktok.com/@michelngoyikalend" target="_blank" rel="noopener noreferrer"',
    'href="https://x.com/kalenda1497" target="_blank" rel="noopener noreferrer"',
    'href="https://www.linkedin.com/in/michel-ngoyi-296ba4241" target="_blank" rel="noopener noreferrer"',
    'href="https://www.facebook.com/michel.ngoyikalenda" target="_blank" rel="noopener noreferrer"',
  ]) {
    assert.ok(footer.includes(link), `Contact link must open safely in a new tab: ${link}`);
  }
  for (const [, source] of footer.matchAll(/<img[^>]*src="([^"]+)"/g)) {
    const icon = await fetch(`${baseUrl}${source}`);
    assert.equal(icon.status, 200, `Footer image unavailable: ${source}`);
    assert.match(icon.headers.get("content-type"), /^image\//);
    assert.ok((await icon.arrayBuffer()).byteLength > 0);
  }
  assert.match(pageHtml, /id="ticketModal"/);
  assert.match(pageHtml, /<dialog id="roomDetailsDialog"[^>]*aria-labelledby="roomDetailsTitle"/);
  for (const id of ["roomDetailsImage", "roomDetailsInfo", "roomDetailsPrevious", "roomDetailsNext", "roomDetailsReserve"]) {
    assert.match(pageHtml, new RegExp(`id="${id}"`));
  }
  assert.match(pageHtml, /Télécharger le ticket PDF/);
  assert.match(pageHtml, /id="printTicketBtn">Imprimer/);
  for (const section of ["homeSection", "aboutSection", "reservationSection", "servicesSection"]) {
    assert.match(pageHtml, new RegExp(`href="#${section}"`));
    assert.match(pageHtml, new RegExp(`id="${section}"`));
  }
  assert.match(pageHtml, /Nos services/);
  const roomTypeSelect = pageHtml.match(/<select id="newRoomType">([\s\S]*?)<\/select>/)?.[1] || "";
  assert.doesNotMatch(pageHtml, /Veillée mortuaire/);
  assert.match(pageHtml, /<option>Salle mortuaire<\/option>/);
  for (const type of ["Mariage", "Salle mortuaire", "Anniversaire"]) {
    assert.match(roomTypeSelect, new RegExp(`<option>${type}</option>`));
  }
  assert.equal(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), true);
  assert.equal((await fetch(`${baseUrl}/server.mjs`)).status, 404);
  const datetimeModule = await fetch(`${baseUrl}/datetime.mjs`);
  assert.equal(datetimeModule.status, 200);
  assert.match(datetimeModule.headers.get("content-type"), /javascript/);
  assert.match(await datetimeModule.text(), /Africa\/Lubumbashi/);
  assert.match(pageHtml, /<script type="module" src="script.js"><\/script>/);
  const logo = await fetch(`${baseUrl}/assets/brand-logo.png`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type"), /image\/png/);
  assert.ok((await logo.arrayBuffer()).byteLength > 1000);
  const roomPhoto = await fetch(`${baseUrl}/assets/rooms/gallery/hall-classic.jpg`);
  assert.equal(roomPhoto.status, 200);
  assert.match(roomPhoto.headers.get("content-type"), /image\/jpeg/);
  assert.ok((await roomPhoto.arrayBuffer()).byteLength > 1000);
  for (let slide = 1; slide <= 7; slide += 1) {
    const bannerPhoto = await fetch(`${baseUrl}/assets/rooms/banner/slide-${slide}.jpg`);
    assert.equal(bannerPhoto.status, 200, `Banner photo ${slide} should be public.`);
    assert.match(bannerPhoto.headers.get("content-type"), /image\/jpeg/);
    assert.ok((await bannerPhoto.arrayBuffer()).byteLength > 1000);
  }

  const badLogin = await call("/api/auth/login", {
    method: "POST",
    body: { email: "admin@example.test", password: "wrong-password" },
  });
  assert.equal(badLogin.response.status, 401);
  assert.equal(badLogin.payload.error, "Adresse e-mail ou mot de passe incorrect. Le mot de passe doit contenir entre 8 et 12 caractères.");

  const login = await call("/api/auth/login", {
    method: "POST",
    body: { email: "admin@example.test", password: initialPassword },
  });
  assert.equal(login.response.status, 200);
  let adminCookie = cookieFrom(login.response);
  let adminCsrf = login.payload.csrfToken;
  assert.match(login.response.headers.getSetCookie().join(";"), /HttpOnly/);
  assert.match(login.response.headers.getSetCookie().join(";"), /SameSite=Strict/);
  assert.equal(typeof adminCsrf, "string");

  const sampleRoomPhoto = readFileSync(join(projectRoot, "assets", "rooms", "gallery", "boardroom.jpg"));
  const imageUploadResponse = await fetch(`${baseUrl}/api/room-images`, {
    method: "POST",
    headers: {
      Cookie: adminCookie,
      Origin: baseUrl,
      "X-CSRF-Token": adminCsrf,
      "Content-Type": "image/jpeg",
    },
    body: sampleRoomPhoto,
  });
  assert.equal(imageUploadResponse.status, 201);
  const uploadedPhoto = await imageUploadResponse.json();
  assert.match(uploadedPhoto.key, /^upload-[0-9a-f-]{36}\.jpg$/);
  const uploadedPhotoResponse = await fetch(`${baseUrl}/api/room-images/${uploadedPhoto.key}`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(uploadedPhotoResponse.status, 200);
  assert.match(uploadedPhotoResponse.headers.get("content-type"), /image\/jpeg/);
  assert.deepEqual(Buffer.from(await uploadedPhotoResponse.arrayBuffer()), sampleRoomPhoto);
  const privateUploadedPhoto = await fetch(`${baseUrl}/api/room-images/${uploadedPhoto.key}`);
  assert.equal(privateUploadedPhoto.status, 401);
  const invalidPhotoUpload = await fetch(`${baseUrl}/api/room-images`, {
    method: "POST",
    headers: {
      Cookie: adminCookie,
      Origin: baseUrl,
      "X-CSRF-Token": adminCsrf,
      "Content-Type": "image/jpeg",
    },
    body: Buffer.from("not an image"),
  });
  assert.equal(invalidPhotoUpload.status, 400);

  const bootstrap = await call("/api/bootstrap", { cookie: adminCookie });
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.payload.rooms.length, 4);
  assert.ok(bootstrap.payload.rooms.every((room) => room.imageKeys.length >= 1));
  assert.equal(bootstrap.payload.rooms.flatMap((room) => room.imageKeys).length, 9);
  const activeGalleryKeys = [...new Set(bootstrap.payload.rooms.filter((room) => room.active).flatMap((room) => room.imageKeys))].sort();
  assert.deepEqual(activeGalleryKeys, [
    "auditorium", "boardroom", "classroom", "council-room", "hall-classic", "hall-lodge", "meeting-centara",
  ]);

  const missingCsrf = await call("/api/rooms", {
    method: "POST", cookie: adminCookie,
    body: { name: "Salle interdite", code: "NO-CSRF" },
  });
  assert.equal(missingCsrf.response.status, 403);

  const wrongOrigin = await call("/api/rooms", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf, origin: "https://attacker.invalid",
    body: { name: "Salle interdite", code: "BAD-ORIGIN" },
  });
  assert.equal(wrongOrigin.response.status, 403);

  for (const password of ["1234567", "1234567890123"]) {
    const rejected = await call("/api/users", {
      method: "POST", cookie: adminCookie, csrf: adminCsrf,
      body: { name: "Utilisateur Test", email: "user@example.test", role: "Utilisateur", password },
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.payload.error, /entre 8 et 12 caractères/);
  }
  const createdUser = await call("/api/users", {
    method: "POST",
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { name: "Utilisateur Test", email: "user@example.test", role: "Utilisateur", password: "User123!" },
  });
  assert.equal(createdUser.response.status, 201);
  const createdRoom = await call("/api/rooms", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf,
    body: { name: "Salle API", code: "API-01", type: "Réunion", capacity: 8, equipment: "", location: "", open: "08:00", close: "20:00", maxDuration: 4, active: true, imageKeys: ["boardroom", uploadedPhoto.key] },
  });
  assert.equal(createdRoom.response.status, 201);
  assert.deepEqual(createdRoom.payload.room.imageKeys, ["boardroom", uploadedPhoto.key]);
  for (const invalidTime of ["24:00", "08:60", "08 AM"]) {
    const invalidRoomTime = await call("/api/rooms", {
      method: "POST", cookie: adminCookie, csrf: adminCsrf,
      body: { ...createdRoom.payload.room, name: "Horaire invalide", code: "BAD-TIME", open: invalidTime },
    });
    assert.equal(invalidRoomTime.response.status, 400);
  }
  for (const [index, type] of ["Mariage", "Salle mortuaire", "Anniversaire"].entries()) {
    const typedRoom = await call("/api/rooms", {
      method: "POST",
      cookie: adminCookie,
      csrf: adminCsrf,
      body: {
        name: `Salle type ${index + 1}`,
        code: `TYPE-0${index + 1}`,
        type,
        capacity: 12,
        equipment: "",
        location: "",
        open: "08:00",
        close: "20:00",
        maxDuration: 4,
        active: true,
        imageKeys: ["boardroom"],
      },
    });
    assert.equal(typedRoom.response.status, 201);
    assert.equal(typedRoom.payload.room.type, type);
  }
  const deleteRoomPhotoInUse = await fetch(`${baseUrl}/api/room-images/${uploadedPhoto.key}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie, Origin: baseUrl, "X-CSRF-Token": adminCsrf },
  });
  assert.equal(deleteRoomPhotoInUse.status, 409);
  const invalidRoomImage = await call("/api/rooms", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf,
    body: { name: "Image non autorisée", code: "BAD-IMG", type: "Réunion", capacity: 8, equipment: "", location: "", open: "08:00", close: "20:00", maxDuration: 4, active: true, imageKeys: ["../private"] },
  });
  assert.equal(invalidRoomImage.response.status, 400);
  const missingRoomImage = await call("/api/rooms", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf,
    body: { name: "Sans image", code: "NO-IMG", type: "Réunion", capacity: 8, equipment: "", location: "", open: "08:00", close: "20:00", maxDuration: 4, active: true, imageKeys: [] },
  });
  assert.equal(missingRoomImage.response.status, 400);
  const updateRoomImages = await call(`/api/rooms/${createdRoom.payload.room.id}`, {
    method: "PUT", cookie: adminCookie, csrf: adminCsrf,
    body: { name: "Salle API", code: "API-01", type: "Réunion", capacity: 8, equipment: "", location: "", open: "08:00", close: "20:00", maxDuration: 4, active: true, imageKeys: ["hall-lodge", "auditorium", "meeting-centara"] },
  });
  assert.equal(updateRoomImages.response.status, 200);
  assert.deepEqual(updateRoomImages.payload.room.imageKeys, ["hall-lodge", "auditorium", "meeting-centara"]);
  const deleteUnusedRoomPhoto = await fetch(`${baseUrl}/api/room-images/${uploadedPhoto.key}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie, Origin: baseUrl, "X-CSRF-Token": adminCsrf },
  });
  assert.equal(deleteUnusedRoomPhoto.status, 200);
  const privateDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const privateBooking = await call("/api/reservations", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf,
    body: { roomId: 2, date: privateDate, start: "13:00", end: "14:00", title: "Réunion confidentielle", guests: 3, comment: "Note privée", recurrence: "none", occurrences: 1 },
  });
  assert.equal(privateBooking.response.status, 201);
  assert.match(privateBooking.payload.reservations[0].ticketNumber, /^RF-\d{4}-\d{6}$/);

  const userLogin = await call("/api/auth/login", {
    method: "POST",
    body: { email: "user@example.test", password: "User123!" },
  });
  assert.equal(userLogin.response.status, 200);
  const userCookie = cookieFrom(userLogin.response);
  const userCsrf = userLogin.payload.csrfToken;
  const deniedRoomPhotoUpload = await fetch(`${baseUrl}/api/room-images`, {
    method: "POST",
    headers: {
      Cookie: userCookie,
      Origin: baseUrl,
      "X-CSRF-Token": userCsrf,
      "Content-Type": "image/jpeg",
    },
    body: sampleRoomPhoto,
  });
  assert.equal(deniedRoomPhotoUpload.status, 403);
  const deniedRoom = await call("/api/rooms", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { name: "Salle interdite", code: "NO-ROLE", type: "Réunion", capacity: 8, equipment: "", location: "", open: "08:00", close: "20:00", maxDuration: 4, active: true },
  });
  assert.equal(deniedRoom.response.status, 403);
  const deniedUsers = await call("/api/users", { cookie: userCookie });
  assert.equal(deniedUsers.response.status, 403);
  const userWorkspace = await call("/api/bootstrap", { cookie: userCookie });
  const redactedBooking = userWorkspace.payload.reservations.find((item) => item.id === privateBooking.payload.reservations[0].id);
  assert.equal(redactedBooking.title, "Réservation occupée");
  assert.equal(redactedBooking.eventType, "Réservation occupée");
  assert.equal("ticketNumber" in redactedBooking, false);
  assert.equal(redactedBooking.comment, "");
  assert.deepEqual(userWorkspace.payload.notifications, []);
  assert.equal(userWorkspace.payload.unreadNotificationCount, 0);

  const bookingDate = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
  const booking = { roomId: 1, date: bookingDate, start: "13:00", end: "14:00", title: "Réservation protégée", eventType: "Mariage", guests: 3, comment: "" };
  const recurrenceDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const hourly = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, date: recurrenceDate, start: "08:00", end: "09:00", recurrence: "hourly", recurrenceInterval: 2, occurrences: 3 },
  });
  assert.equal(hourly.response.status, 201);
  assert.deepEqual(hourly.payload.reservations.map(({ date, start, end }) => [date, start, end]), [
    [recurrenceDate, "08:00", "09:00"], [recurrenceDate, "10:00", "11:00"], [recurrenceDate, "12:00", "13:00"],
  ]);
  const dailyDate = new Date(Date.now() + 65 * 86400000).toISOString().slice(0, 10);
  const daily = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, date: dailyDate, recurrence: "daily", recurrenceInterval: 3, occurrences: 3 },
  });
  assert.equal(daily.response.status, 201);
  assert.deepEqual(daily.payload.reservations.map(({ date, start, end }) => [date, start, end]),
    [65, 68, 71].map((days) => [new Date(Date.now() + days * 86400000).toISOString().slice(0, 10), "13:00", "14:00"]));
  for (const recurrenceInterval of [0, -1, 1.5, "invalide", 1e30]) {
    const invalidInterval = await call("/api/reservations", {
      method: "POST", cookie: userCookie, csrf: userCsrf,
      body: { ...booking, date: dailyDate, recurrence: "hourly", recurrenceInterval, occurrences: 2 },
    });
    assert.equal(invalidInterval.response.status, 400);
  }
  const rollbackDate = new Date(Date.now() + 75 * 86400000).toISOString().slice(0, 10);
  for (const [start, end, recurrenceInterval, status] of [
    ["08:00", "10:00", 1, 409],
    ["08:00", "09:00", 15, 400],
    ["08:00", "10:00", 1e12, 400],
  ]) {
    const failedSeries = await call("/api/reservations", {
      method: "POST", cookie: userCookie, csrf: userCsrf,
      body: { ...booking, date: rollbackDate, start, end, recurrence: "hourly", recurrenceInterval, occurrences: 2 },
    });
    assert.equal(failedSeries.response.status, status);
    const workspace = await call("/api/bootstrap", { cookie: userCookie });
    assert.equal(workspace.payload.reservations.some((item) => item.date === rollbackDate), false);
  }
  const createdBooking = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, recurrence: "none", occurrences: 1 },
  });
  assert.equal(createdBooking.response.status, 201);
  assert.equal(createdBooking.payload.reservations[0].owner, "Utilisateur Test");
  assert.equal(createdBooking.payload.reservations[0].eventType, "Mariage");
  assert.match(createdBooking.payload.reservations[0].ticketNumber, /^RF-\d{4}-\d{6}$/);
  const invalidEventType = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, date: new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10), start: "13:00", end: "14:00", eventType: "Événement non autorisé", recurrence: "none", occurrences: 1 },
  });
  assert.equal(invalidEventType.response.status, 400);
  const updatedBooking = await call(`/api/reservations/${createdBooking.payload.reservations[0].id}`, {
    method: "PUT", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, eventType: "Anniversaire" },
  });
  assert.equal(updatedBooking.response.status, 200);
  assert.equal(updatedBooking.payload.reservation.eventType, "Anniversaire");
  const bookingNotifications = await call("/api/bootstrap", { cookie: userCookie });
  assert.deepEqual(bookingNotifications.payload.notifications, []);
  assert.equal(bookingNotifications.payload.unreadNotificationCount, 0);
  assert.deepEqual(bookingNotifications.payload.logs, []);
  const readStoredNotifications = () => {
    const db = new DatabaseSync(join(dataDirectory, "roomflow.sqlite"));
    try {
      return db.prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC").all(userLogin.payload.user.id);
    } finally {
      db.close();
    }
  };
  assert.equal(readStoredNotifications()[0].title, "Réservation modifiée");
  assert.equal(readStoredNotifications()[1].title, "Demande envoyée");
  const notificationId = readStoredNotifications()[0].id;
  const deniedNotificationRead = await call(`/api/notifications/${notificationId}/read`, {
    method: "POST", cookie: adminCookie, csrf: adminCsrf, body: {},
  });
  assert.equal(deniedNotificationRead.response.status, 404);
  const conflictingBooking = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, title: "Conflit", start: "13:30", end: "14:30", recurrence: "none", occurrences: 1 },
  });
  assert.equal(conflictingBooking.response.status, 409);
  const markedRead = await call(`/api/notifications/${notificationId}/read`, {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(markedRead.response.status, 403);
  const readNotificationState = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(readNotificationState.payload.unreadNotificationCount, 0);
  const markedCreationRead = await call(`/api/notifications/${readStoredNotifications()[1].id}/read`, {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(markedCreationRead.response.status, 403);
  const allBookingNotificationsRead = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(allBookingNotificationsRead.payload.unreadNotificationCount, 0);

  const confirmed = await call(`/api/reservations/${createdBooking.payload.reservations[0].id}/status`, {
    method: "PATCH", cookie: adminCookie, csrf: adminCsrf, body: { status: "confirmé" },
  });
  assert.equal(confirmed.response.status, 200);
  const confirmationNotification = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(readStoredNotifications()[0].title, "Réservation confirmée");
  assert.deepEqual(confirmationNotification.payload.notifications, []);
  assert.equal(confirmationNotification.payload.unreadNotificationCount, 0);
  const markAllRead = await call("/api/notifications/read-all", {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(markAllRead.response.status, 403);
  assert.equal((await call("/api/bootstrap", { cookie: userCookie })).payload.unreadNotificationCount, 0);

  const refusedBooking = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, start: "15:00", end: "16:00", title: "Demande à refuser", recurrence: "none", occurrences: 1 },
  });
  assert.equal(refusedBooking.response.status, 201);
  const refused = await call(`/api/reservations/${refusedBooking.payload.reservations[0].id}/status`, {
    method: "PATCH", cookie: adminCookie, csrf: adminCsrf, body: { status: "refusé" },
  });
  assert.equal(refused.response.status, 200);
  const refusalNotification = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(readStoredNotifications()[0].title, "Demande refusée");
  assert.deepEqual(refusalNotification.payload.notifications, []);
  assert.equal(refusalNotification.payload.unreadNotificationCount, 0);
  const readRefusalNotifications = await call("/api/notifications/read-all", {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(readRefusalNotifications.response.status, 403);

  const cancellableBooking = await call("/api/reservations", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { ...booking, start: "16:00", end: "17:00", title: "Demande à annuler", recurrence: "none", occurrences: 1 },
  });
  assert.equal(cancellableBooking.response.status, 201);
  const cancellation = await call(`/api/reservations/${cancellableBooking.payload.reservations[0].id}/cancel`, {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: { reason: "Changement de programme" },
  });
  assert.equal(cancellation.response.status, 200);
  const cancellationNotification = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(readStoredNotifications()[0].title, "Réservation annulée");
  assert.match(readStoredNotifications()[0].message, /Changement de programme/);
  assert.deepEqual(cancellationNotification.payload.notifications, []);
  assert.deepEqual(cancellationNotification.payload.logs, []);

  const adminWorkspace = await call("/api/bootstrap", { cookie: adminCookie });
  assert.ok(adminWorkspace.payload.logs.length > 0);
  assert.ok(adminWorkspace.payload.notifications.length > 0);
  const adminNotification = adminWorkspace.payload.notifications[0];
  assert.equal((await call(`/api/notifications/${adminNotification.id}/read`, {
    method: "POST", cookie: adminCookie, csrf: adminCsrf, body: {},
  })).response.status, 200);
  assert.equal((await call("/api/notifications/read-all", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf, body: {},
  })).response.status, 200);
  assert.equal((await call("/api/bootstrap", { cookie: adminCookie })).payload.unreadNotificationCount, 0);

  const promoted = await call(`/api/users/${userLogin.payload.user.id}`, {
    method: "PATCH", cookie: adminCookie, csrf: adminCsrf, body: { role: "Gestionnaire" },
  });
  assert.equal(promoted.response.status, 200);
  const managerWorkspace = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(managerWorkspace.payload.user.role, "Gestionnaire");
  assert.deepEqual(managerWorkspace.payload.logs, []);
  assert.deepEqual(managerWorkspace.payload.notifications, []);
  assert.equal(managerWorkspace.payload.unreadNotificationCount, 0);
  for (const path of ["/api/notifications/read-all", `/api/notifications/${notificationId}/read`]) {
    assert.equal((await call(path, {
      method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
    })).response.status, 403);
  }
  assert.equal((await call(`/api/users/${userLogin.payload.user.id}`, {
    method: "PATCH", cookie: adminCookie, csrf: adminCsrf, body: { role: "Utilisateur" },
  })).response.status, 200);

  for (const [cookie, csrf, currentPassword] of [
    [adminCookie, adminCsrf, initialPassword],
    [userCookie, userCsrf, "User123!"],
  ]) {
    for (const newPassword of ["1234567", "1234567890123"]) {
      const rejected = await call("/api/auth/password", {
        method: "POST", cookie, csrf,
        body: { currentPassword, newPassword },
      });
      assert.equal(rejected.response.status, 400);
      assert.match(rejected.payload.error, /entre 8 et 12 caractères/);
    }
  }
  const adminPasswordChange = await call("/api/auth/password", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf,
    body: { currentPassword: initialPassword, newPassword: "Admin123456!" },
  });
  assert.equal(adminPasswordChange.response.status, 200);
  const passwordChange = await call("/api/auth/password", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { currentPassword: "User123!", newPassword: "New1234!" },
  });
  assert.equal(passwordChange.response.status, 200);
  const rotatedCookie = cookieFrom(passwordChange.response);
  const revokedSession = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(revokedSession.response.status, 401);
  const logout = await call("/api/auth/logout", { method: "POST", cookie: rotatedCookie, csrf: passwordChange.payload.csrfToken, body: {} });
  assert.equal(logout.response.status, 200);
  const afterLogout = await call("/api/bootstrap", { cookie: rotatedCookie });
  assert.equal(afterLogout.response.status, 401);
});

test("first-run setup and public registration preserve account roles and limits", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "roomflow-setup-test-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  const startServer = () => {
    const childProcess = spawn(process.execPath, ["server.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ROOMFLOW_DATA_DIR: dataDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    childProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
    return childProcess;
  };
  let child = startServer();
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3000),
    ]);
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, `Server did not start. ${serverOutput}`);

  const initialStatus = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await initialStatus.json(), { initialSetupRequired: true });
  const register = (body, origin = baseUrl) => fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
  const registrationInput = {
    name: "Nouveau Client",
    email: "  Client@Example.test  ",
    password: "User1234567!",
    role: "Administrateur",
    active: false,
  };
  const beforeSetup = await register(registrationInput);
  assert.equal(beforeSetup.status, 409);
  for (const password of ["1234567", "1234567890123"]) {
    const rejected = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ name: "Premier Admin", email: "first@example.test", password }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /entre 8 et 12 caractères/);
  }
  const input = JSON.stringify({ name: "Premier Admin", email: "first@example.test", password: "Admin123" });
  const createFirstAdmin = () => fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: input,
  });
  const results = await Promise.all([createFirstAdmin(), createFirstAdmin()]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const finalStatus = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await finalStatus.json(), { initialSetupRequired: false });

  const db = new DatabaseSync(join(dataDirectory, "roomflow.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  assert.equal(db.prepare("SELECT role FROM users LIMIT 1").get().role, "Administrateur");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
  db.close();

  const invalidOrigin = await register(registrationInput, "https://other.example.test");
  assert.equal(invalidOrigin.status, 403);
  for (const invalid of [
    { name: "" },
    { name: "x".repeat(81) },
    { email: "invalid" },
    { password: "1234567" },
    { password: "x".repeat(13) },
  ]) {
    const response = await register({
      ...registrationInput,
      email: `invalid-${Object.keys(invalid)[0]}-${Object.values(invalid)[0].length}@example.test`,
      ...invalid,
    });
    assert.equal(response.status, 400);
  }

  const registration = await register(registrationInput);
  assert.equal(registration.status, 201);
  const session = await registration.json();
  assert.deepEqual(session.user, {
    id: 2, name: "Nouveau Client", email: "client@example.test", role: "Utilisateur",
  });
  assert.equal(typeof session.csrfToken, "string");
  assert.match(registration.headers.getSetCookie().join(";"), /HttpOnly/);
  const cookie = registration.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const workspace = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(workspace.status, 200);
  assert.equal((await workspace.json()).user.role, "Utilisateur");
  const deniedUsers = await fetch(`${baseUrl}/api/users`, { headers: { Cookie: cookie } });
  assert.equal(deniedUsers.status, 403);
  const deniedRoom = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Origin: baseUrl,
      Cookie: cookie, "X-CSRF-Token": session.csrfToken,
    },
    body: "{}",
  });
  assert.equal(deniedRoom.status, 403);
  const duplicate = await register({ ...registrationInput, email: "CLIENT@example.test" });
  assert.equal(duplicate.status, 409);
  const duplicateAdmin = await register({ ...registrationInput, email: "first@example.test" });
  assert.equal(duplicateAdmin.status, 409);
  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Origin: baseUrl,
      Cookie: cookie, "X-CSRF-Token": session.csrfToken,
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.getSetCookie().join(";"), /Max-Age=0/);
  const loggedOut = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(loggedOut.status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: "client@example.test", password: registrationInput.password }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.role, "Utilisateur");

  const registeredDb = new DatabaseSync(join(dataDirectory, "roomflow.sqlite"));
  const account = registeredDb.prepare("SELECT * FROM users WHERE email='client@example.test'").get();
  assert.equal(account.role, "Utilisateur");
  assert.equal(account.active, 1);
  assert.notEqual(account.password_hash, registrationInput.password);
  assert.equal(registeredDb.prepare("SELECT COUNT(*) AS count FROM users").get().count, 2);
  assert.equal(registeredDb.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='Inscription'").get().count, 1);
  registeredDb.close();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const limited = await register({ ...registrationInput, email: "limited@example.test", password: "short" });
    assert.equal(limited.status, attempt < 5 ? 400 : 429);
  }

  const stopped = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await stopped;
  child = startServer();
  ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) {
        assert.deepEqual(await response.json(), { initialSetupRequired: false });
        ready = true;
        break;
      }
    } catch {
      // The restarted server might not be listening yet.
    }
    await delay(100);
  }
  assert.ok(ready, `Server did not restart. ${serverOutput}`);
  const reconnect = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ email: "client@example.test", password: registrationInput.password }),
  });
  assert.equal(reconnect.status, 200);
  const reconnectedSession = await reconnect.json();
  assert.deepEqual(reconnectedSession.user, session.user);
  const reconnectedCookie = reconnect.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const logoutAfterRestart = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Origin: baseUrl,
      Cookie: reconnectedCookie, "X-CSRF-Token": reconnectedSession.csrfToken,
    },
    body: "{}",
  });
  assert.equal(logoutAfterRestart.status, 200);
  const persistedDb = new DatabaseSync(join(dataDirectory, "roomflow.sqlite"));
  const persistedUser = persistedDb.prepare("SELECT id, name, email, role FROM users WHERE id=?").get(session.user.id);
  assert.deepEqual({ ...persistedUser }, session.user);
  persistedDb.close();
});

test("existing room image choices migrate to photo galleries", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "roomflow-gallery-migration-"));
  const dbPath = join(dataDirectory, "roomflow.sqlite");
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      code TEXT NOT NULL COLLATE NOCASE UNIQUE,
      type TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      equipment TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      open_time TEXT NOT NULL,
      close_time TEXT NOT NULL,
      max_duration INTEGER NOT NULL,
      image_key TEXT NOT NULL DEFAULT 'meeting'
    );
    INSERT INTO rooms (name, code, type, capacity, equipment, location, active, open_time, close_time, max_duration, image_key)
    VALUES ('Ancienne salle', 'OLD-01', 'Formation', 18, '', 'Bâtiment A', 1, '08:00', '20:00', 4, 'training');
    INSERT INTO rooms (name, code, type, capacity, open_time, close_time, max_duration)
    VALUES ('Ancien type', 'OLD-02', 'Veillée mortuaire', 20, '08:00', '20:00', 4);
  `);
  legacyDb.close();

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ROOMFLOW_DATA_DIR: dataDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(3000),
    ]);
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, `Server did not start. ${serverOutput}`);

  const migratedDb = new DatabaseSync(dbPath);
  const gallery = migratedDb.prepare("SELECT image_key, image_keys FROM rooms WHERE code='OLD-01'").get();
  assert.equal(gallery.image_key, "classroom");
  assert.deepEqual(JSON.parse(gallery.image_keys), ["classroom", "auditorium"]);
  assert.equal(migratedDb.prepare("SELECT type FROM rooms WHERE code='OLD-02'").get().type, "Salle mortuaire");
  migratedDb.close();
});
