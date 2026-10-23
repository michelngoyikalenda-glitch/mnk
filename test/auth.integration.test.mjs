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
  assert.match(pageHtml, /Espace sécurisé/);
  assert.match(pageHtml, /src="\/assets\/brand-logo\.png"/);
  assert.match(pageHtml, /id="ticketModal"/);
  assert.match(pageHtml, /Télécharger le ticket PDF/);
  assert.match(pageHtml, /id="printTicketBtn">Imprimer/);
  for (const section of ["homeSection", "aboutSection", "reservationSection", "servicesSection"]) {
    assert.match(pageHtml, new RegExp(`href="#${section}"`));
    assert.match(pageHtml, new RegExp(`id="${section}"`));
  }
  assert.match(pageHtml, /Nos services/);
  const roomTypeSelect = pageHtml.match(/<select id="newRoomType">([\s\S]*?)<\/select>/)?.[1] || "";
  for (const type of ["Mariage", "Veillée mortuaire", "Anniversaire"]) {
    assert.match(roomTypeSelect, new RegExp(`<option>${type}</option>`));
  }
  assert.equal(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), true);
  assert.equal((await fetch(`${baseUrl}/server.mjs`)).status, 404);
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

  const createdUser = await call("/api/users", {
    method: "POST",
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { name: "Utilisateur Test", email: "user@example.test", role: "Utilisateur", password: "A Secure User Pass 2026!" },
  });
  assert.equal(createdUser.response.status, 201);
  const createdRoom = await call("/api/rooms", {
    method: "POST", cookie: adminCookie, csrf: adminCsrf,
    body: { name: "Salle API", code: "API-01", type: "Réunion", capacity: 8, equipment: "", location: "", open: "08:00", close: "20:00", maxDuration: 4, active: true, imageKeys: ["boardroom", uploadedPhoto.key] },
  });
  assert.equal(createdRoom.response.status, 201);
  assert.deepEqual(createdRoom.payload.room.imageKeys, ["boardroom", uploadedPhoto.key]);
  for (const [index, type] of ["Mariage", "Veillée mortuaire", "Anniversaire"].entries()) {
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
    body: { email: "user@example.test", password: "A Secure User Pass 2026!" },
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
  assert.equal(bookingNotifications.payload.notifications.length, 2);
  assert.equal(bookingNotifications.payload.notifications[0].title, "Réservation modifiée");
  assert.equal(bookingNotifications.payload.notifications[1].title, "Demande envoyée");
  assert.equal(bookingNotifications.payload.unreadNotificationCount, 2);
  const notificationId = bookingNotifications.payload.notifications[0].id;
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
  assert.equal(markedRead.response.status, 200);
  const readNotificationState = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(readNotificationState.payload.unreadNotificationCount, 1);
  const markedCreationRead = await call(`/api/notifications/${bookingNotifications.payload.notifications[1].id}/read`, {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(markedCreationRead.response.status, 200);
  const allBookingNotificationsRead = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(allBookingNotificationsRead.payload.unreadNotificationCount, 0);

  const confirmed = await call(`/api/reservations/${createdBooking.payload.reservations[0].id}/status`, {
    method: "PATCH", cookie: adminCookie, csrf: adminCsrf, body: { status: "confirmé" },
  });
  assert.equal(confirmed.response.status, 200);
  const confirmationNotification = await call("/api/bootstrap", { cookie: userCookie });
  assert.equal(confirmationNotification.payload.notifications[0].title, "Réservation confirmée");
  assert.equal(confirmationNotification.payload.unreadNotificationCount, 1);
  const markAllRead = await call("/api/notifications/read-all", {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(markAllRead.response.status, 200);
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
  assert.equal(refusalNotification.payload.notifications[0].title, "Demande refusée");
  assert.equal(refusalNotification.payload.unreadNotificationCount, 2);
  const readRefusalNotifications = await call("/api/notifications/read-all", {
    method: "POST", cookie: userCookie, csrf: userCsrf, body: {},
  });
  assert.equal(readRefusalNotifications.response.status, 200);

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
  assert.equal(cancellationNotification.payload.notifications[0].title, "Réservation annulée");
  assert.match(cancellationNotification.payload.notifications[0].message, /Changement de programme/);

  const passwordChange = await call("/api/auth/password", {
    method: "POST", cookie: userCookie, csrf: userCsrf,
    body: { currentPassword: "A Secure User Pass 2026!", newPassword: "An Even Safer User Pass 2027!" },
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

test("first-run setup creates only one administrator", async (t) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "roomflow-setup-test-"));
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

  const initialStatus = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await initialStatus.json(), { initialSetupRequired: true });
  const input = JSON.stringify({ name: "Premier Admin", email: "first@example.test", password: "First Admin Password 2026!" });
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
  migratedDb.close();
});
