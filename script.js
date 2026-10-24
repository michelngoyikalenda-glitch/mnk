"use strict";

import { dateToISO, formatDate, formatDateTime, shiftDate } from "./datetime.mjs";

const ACTIVE_STATUSES = new Set(["confirmé", "en attente"]);
const ROOM_GALLERY_IMAGES = [
  { key: "hall-classic", label: "Salle de conférence" },
  { key: "classroom", label: "Salle de formation" },
  { key: "hall-lodge", label: "Salle événementielle" },
  { key: "auditorium", label: "Auditorium" },
  { key: "boardroom", label: "Salle moderne" },
  { key: "meeting-centara", label: "Salle de réunion" },
  { key: "council-room", label: "Salle de conseil" },
];
const dateInput = document.getElementById("reservationDate");
const toast = document.getElementById("toast");
let toastTimeout;
let csrfToken = "";
let authMode = "login";
let roomDetailsId = null;
let roomDetailsImageIndex = 0;
let users = [];
let roomPhotoItems = [];
let roomFormSaving = false;
let ticketReturnFocus = null;
let activeTicketReservations = [];
let activeTicketOrganization = { physicalAddress: "", referenceDetails: "" };
let state = {
  role: "",
  userName: "",
  calendarDate: dateToISO(new Date()),
  calendarView: "month",
  rooms: [],
  organization: { physicalAddress: "", referenceDetails: "" },
  roomGalleryIndexes: {},
  reservations: [],
  notifications: [],
  unreadNotificationCount: 0,
  logs: [],
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function apiRequest(path, options = {}) {
  const { rawBody = false, ...fetchOptions } = options;
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !rawBody) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && options.method !== "HEAD" && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      credentials: "same-origin",
      headers,
      body: options.body === undefined ? undefined : rawBody ? options.body : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ApiError(0, "Le serveur RoomFlow est inaccessible. Démarrez-le avec « npm start », puis ouvrez http://127.0.0.1:3000.");
    }
    throw error;
  }
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/login")) showLogin();
    if (response.status === 404 && path.startsWith("/api/")) {
      throw new ApiError(404, "L’API RoomFlow est introuvable à cette adresse. Ouvrez http://127.0.0.1:3000 et vérifiez que le serveur est démarré.");
    }
    throw new ApiError(response.status, result.error || "La requête a échoué.");
  }
  return result;
}

function roomImageUrl(key) {
  return key.startsWith("upload-")
    ? `/api/room-images/${encodeURIComponent(key)}`
    : `/assets/rooms/gallery/${encodeURIComponent(key)}.jpg`;
}

function isUploadedRoomImageKey(key) {
  return typeof key === "string" &&
    /^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(key);
}

async function loadWorkspace() {
  const data = await apiRequest("/api/bootstrap");
  state = {
    ...state,
    role: data.user.role,
    userName: data.user.name,
    user: data.user,
    rooms: data.rooms,
    organization: data.organization || { physicalAddress: "", referenceDetails: "" },
    reservations: data.reservations,
    notifications: data.user.role === "Administrateur" ? data.notifications || [] : [],
    unreadNotificationCount: data.user.role === "Administrateur" ? Number(data.unreadNotificationCount || 0) : 0,
    logs: data.user.role === "Administrateur" ? data.logs : [],
  };
  if (state.role === "Administrateur") {
    const result = await apiRequest("/api/users");
    users = result.users;
  } else {
    users = [];
  }
  render();
}

function showLogin() {
  csrfToken = "";
  showLoginForm();
  document.getElementById("appShell").classList.add("hidden");
  document.getElementById("authScreen").classList.remove("hidden");
  document.getElementById("loginPassword").value = "";
  refreshShowcaseTimer();
}

function showInitialSetup() {
  showAccountForm(true);
}

function showLoginForm() {
  authMode = "login";
  document.getElementById("authTitle").textContent = "Heureux de vous revoir";
  document.getElementById("authDescription").textContent = "Connectez-vous et retrouvez en un instant vos réservations, vos salles favorites et vos prochains rendez-vous.";
  document.getElementById("loginForm").classList.remove("hidden");
  document.getElementById("setupForm").classList.add("hidden");
  document.getElementById("setupForm").reset();
  document.getElementById("loginError").classList.add("hidden");
  document.getElementById("authActions").classList.remove("hidden");
  document.getElementById("showLoginButton").setAttribute("aria-pressed", "true");
  document.getElementById("showRegisterButton").setAttribute("aria-pressed", "false");
  document.getElementById("authHelp").textContent = "Pas encore membre ? Créez votre compte gratuitement en moins d’une minute et commencez à réserver dès aujourd’hui.";
}

function showAccountForm(initialSetup = false) {
  authMode = initialSetup ? "setup" : "register";
  document.getElementById("authTitle").textContent = initialSetup ? "Lancez votre espace RoomFlow" : "Rejoignez RoomFlow";
  document.getElementById("authDescription").textContent = initialSetup
    ? "Créez le compte administrateur et prenez les commandes : ajoutez vos salles, invitez votre équipe et organisez chaque espace en toute simplicité. Cette étape n’est effectuée qu’une seule fois."
    : "Votre prochaine réunion mérite la bonne salle. Créez votre compte une seule fois, puis connectez-vous quand vous le souhaitez pour explorer les salles et réserver en toute sérénité.";
  document.getElementById("loginForm").classList.add("hidden");
  document.getElementById("loginPassword").value = "";
  document.getElementById("setupForm").classList.remove("hidden");
  document.getElementById("setupError").classList.add("hidden");
  document.getElementById("accountPasswordLabel").textContent = initialSetup ? "Mot de passe administrateur" : "Mot de passe";
  document.getElementById("setupButton").textContent = initialSetup ? "Créer mon compte administrateur" : "Créer mon compte et commencer";
  document.getElementById("authActions").classList.toggle("hidden", initialSetup);
  document.getElementById("showLoginButton").setAttribute("aria-pressed", "false");
  document.getElementById("showRegisterButton").setAttribute("aria-pressed", "true");
  document.getElementById("authHelp").textContent = initialSetup
    ? "Le premier compte reçoit le rôle Administrateur. Après sa création, cette configuration est définitivement désactivée."
    : "Gratuit, rapide et sécurisé : votre mot de passe est chiffré et vos informations restent confidentielles. Déjà inscrit ? Cliquez sur « Se connecter ».";
}

async function establishSession() {
  showLoginForm();
  try {
    const session = await apiRequest("/api/auth/me");
    csrfToken = session.csrfToken;
    if (!csrfToken) throw new ApiError(403, "Jeton de sécurité indisponible. Rechargez la page.");
    await loadWorkspace();
    document.getElementById("authScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    refreshShowcaseTimer();
  } catch (error) {
    showLogin();
    if (error.status === 401) {
      try {
        const status = await apiRequest("/api/auth/status");
        if (status.initialSetupRequired) {
          showInitialSetup();
        } else {
          showLoginForm();
        }
      } catch (statusError) {
        document.getElementById("loginError").textContent = statusError.message;
        document.getElementById("loginError").classList.remove("hidden");
      }
    } else {
      document.getElementById("loginError").textContent = error.message;
      document.getElementById("loginError").classList.remove("hidden");
    }
  }
}

async function mutateAndRefresh(path, method, body) {
  await apiRequest(path, { method, body });
  await loadWorkspace();
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.add("hidden"), 3600);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function pdfSafeText(value) {
  return String(value ?? "")
    .replace(/[œŒ]/g, (character) => character === "œ" ? "oe" : "OE")
    .replace(/[æÆ]/g, (character) => character === "æ" ? "ae" : "AE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/([\\()])/g, "\\$1");
}

function wrapPdfText(value, maxLength = 76) {
  const words = pdfSafeText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxLength) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function createTicketPdf(reservations) {
  const objects = [null, "<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"];
  const pageReferences = [];
  for (const reservation of reservations) {
    const room = getRoom(reservation.roomId);
    const commands = [
      "BT /F2 22 Tf 0.12 0.24 0.48 rg 52 782 Td (ROOMFLOW) Tj ET",
      "BT /F1 11 Tf 0.35 0.40 0.48 rg 52 760 Td (TICKET DE RESERVATION) Tj ET",
      `BT /F2 14 Tf 0.12 0.24 0.48 rg 52 731 Td (${pdfSafeText(reservation.ticketNumber)}) Tj ET`,
      "0.75 w 52 714 m 543 714 l S",
      `BT /F1 10 Tf 0.35 0.40 0.48 rg 52 690 Td (ETAT DE LA DEMANDE) Tj ET`,
      `BT /F2 13 Tf 0.65 0.36 0.04 rg 52 670 Td (${pdfSafeText(reservation.status)}) Tj ET`,
    ];
    let y = 638;
    const fields = [
      ["Demandeur", reservation.owner],
      ["Adresse de l’établissement", activeTicketOrganization.physicalAddress],
      ["Références de l’établissement", activeTicketOrganization.referenceDetails],
      ["Salle", `${room?.name || "Salle indisponible"}${room?.code ? ` - ${room.code}` : ""}`],
      ["Adresse de la salle", room?.physicalAddress || ""],
      ["Références de la salle", room?.referenceDetails || ""],
      ["Objet", reservation.title],
      ["Evenement", reservation.eventType || "Reunion"],
      ["Date", formatDate(reservation.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })],
      ["Horaire (CAT, UTC+2)", `${reservation.start} - ${reservation.end}`],
      ["Participants", String(Number(reservation.guests))],
    ];
    for (const [label, value] of fields) {
      if (!String(value ?? "").trim()) continue;
      commands.push(`BT /F1 9 Tf 0.42 0.47 0.55 rg 52 ${y} Td (${pdfSafeText(label).toUpperCase()}) Tj ET`);
      y -= 16;
      for (const line of wrapPdfText(value)) {
        commands.push(`BT /F2 12 Tf 0.10 0.15 0.22 rg 52 ${y} Td (${line}) Tj ET`);
        y -= 16;
      }
      y -= 8;
    }
    commands.push(
      "0.75 w 52 106 m 543 106 l S",
      "BT /F1 9 Tf 0.35 0.40 0.48 rg 52 88 Td (Ce ticket confirme la reception de la demande, pas sa validation.) Tj ET",
    );
    const content = commands.join("\n");
    const pageObjectNumber = objects.length;
    const contentObjectNumber = pageObjectNumber + 1;
    pageReferences.push(`${pageObjectNumber} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[2] = `<< /Type /Pages /Kids [${pageReferences.join(" ")}] /Count ${pageReferences.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const crossReferenceOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

function showReservationTicket(reservations) {
  if (!Array.isArray(reservations) || reservations.length === 0) return;
  activeTicketReservations = reservations;
  activeTicketOrganization = { ...state.organization };
  ticketReturnFocus = document.activeElement;
  document.getElementById("ticketContent").innerHTML = reservations.map((reservation) => {
    const room = getRoom(reservation.roomId);
    return `
      <article class="ticket-card">
        <div class="ticket-heading">
          <div><span class="ticket-brand">ROOMFLOW</span><p class="eyebrow">Ticket de réservation</p></div>
          <strong class="ticket-reference">${escapeHtml(reservation.ticketNumber)}</strong>
        </div>
        <div class="ticket-status"><span>État de la demande</span><strong>${escapeHtml(reservation.status)}</strong></div>
        <dl class="ticket-details">
          <div><dt>Demandeur</dt><dd>${escapeHtml(reservation.owner)}</dd></div>
          ${activeTicketOrganization.physicalAddress ? `<div><dt>Adresse de l’établissement</dt><dd>${escapeHtml(activeTicketOrganization.physicalAddress)}</dd></div>` : ""}
          ${activeTicketOrganization.referenceDetails ? `<div><dt>Références de l’établissement</dt><dd>${escapeHtml(activeTicketOrganization.referenceDetails)}</dd></div>` : ""}
          <div><dt>Salle</dt><dd>${escapeHtml(room?.name || "Salle indisponible")}${room?.code ? ` · ${escapeHtml(room.code)}` : ""}</dd></div>
          ${room?.physicalAddress ? `<div><dt>Adresse physique de la salle</dt><dd>${escapeHtml(room.physicalAddress)}</dd></div>` : ""}
          ${room?.referenceDetails ? `<div><dt>Références de la salle</dt><dd>${escapeHtml(room.referenceDetails)}</dd></div>` : ""}
          <div><dt>Objet</dt><dd>${escapeHtml(reservation.title)}</dd></div>
          <div><dt>Événement</dt><dd>${escapeHtml(reservation.eventType || "Réunion")}</dd></div>
          <div><dt>Date</dt><dd>${escapeHtml(formatDate(reservation.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</dd></div>
          <div><dt>Horaire (CAT, UTC+2)</dt><dd>${escapeHtml(reservation.start)}–${escapeHtml(reservation.end)}</dd></div>
          <div><dt>Participants</dt><dd>${Number(reservation.guests)}</dd></div>
        </dl>
        <p class="ticket-note">Présentez cette référence pour toute demande d’information. Ce ticket confirme la réception de la demande, pas encore la validation de la réservation.</p>
      </article>
    `;
  }).join("");
  const modal = document.getElementById("ticketModal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("closeTicketBtn").focus();
}

function closeReservationTicket() {
  const modal = document.getElementById("ticketModal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  if (ticketReturnFocus instanceof HTMLElement && ticketReturnFocus.isConnected) ticketReturnFocus.focus();
  ticketReturnFocus = null;
  activeTicketReservations = [];
  activeTicketOrganization = { physicalAddress: "", referenceDetails: "" };
}

function downloadReservationTicketPdf() {
  if (activeTicketReservations.length === 0) {
    showToast("Aucun ticket à télécharger.", true);
    return;
  }
  const firstReference = pdfSafeText(activeTicketReservations[0].ticketNumber).replace(/[^A-Za-z0-9-]/g, "");
  const filename = activeTicketReservations.length === 1
    ? `RoomFlow-ticket-${firstReference}.pdf`
    : `RoomFlow-tickets-${firstReference}.pdf`;
  const url = URL.createObjectURL(createTicketPdf(activeTicketReservations));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Ticket PDF téléchargé.");
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function getRoom(roomId) {
  return state.rooms.find((room) => room.id === Number(roomId));
}

function getRoomName(roomId) {
  return getRoom(roomId)?.name || "Salle supprimée";
}

function isManager() {
  return state.role === "Gestionnaire" || state.role === "Administrateur";
}

function canManageReservation(reservation) {
  return isManager() || reservation.ownerId === state.user.id;
}

function getActiveBookingsForRoom(roomId, date, exceptId = null) {
  return state.reservations.filter((reservation) =>
    reservation.roomId === Number(roomId) &&
    reservation.date === date &&
    reservation.id !== exceptId &&
    ACTIVE_STATUSES.has(reservation.status)
  );
}

function renderStats() {
  const today = dateToISO(new Date());
  const activeRooms = state.rooms.filter((room) => room.active).length;
  const todayBookings = state.reservations.filter((booking) => booking.date === today && ACTIVE_STATUSES.has(booking.status)).length;
  const pendingBookings = state.reservations.filter((booking) => booking.status === "en attente").length;
  const occupancy = state.rooms.filter((room) => room.active).reduce((count, room) => count + getActiveBookingsForRoom(room.id, today).length, 0);
  const values = [
    ["Salles actives", activeRooms, "Disponibles à la réservation", "blue"],
    ["Réservations du jour", todayBookings, "Demandes confirmées ou en attente", "green"],
    ["À valider", pendingBookings, "Demandes en attente", "orange"],
    ["Salles avec réservation aujourd’hui", occupancy, "Sur l’ensemble des salles actives", "purple"],
  ];
  document.getElementById("dashboard").innerHTML = values.map(([label, value, hint, tone]) => `
    <article class="stat-card ${tone}">
      <span class="stat-label">${escapeHtml(label)}</span>
      <strong>${value}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `).join("");
}

function getRoomImageKeys(room) {
  const keys = Array.isArray(room.imageKeys)
    ? room.imageKeys.filter((key) => ROOM_GALLERY_IMAGES.some((image) => image.key === key) || isUploadedRoomImageKey(key))
    : [];
  return keys.length ? keys : ["hall-classic"];
}

function updateRoomDetailsImage() {
  const room = getRoom(roomDetailsId);
  if (!room) {
    document.getElementById("roomDetailsDialog").close();
    showToast("Cette salle n’est plus disponible.", true);
    return;
  }
  const keys = getRoomImageKeys(room);
  roomDetailsImageIndex = (roomDetailsImageIndex + keys.length) % keys.length;
  const image = document.getElementById("roomDetailsImage");
  document.getElementById("roomDetailsImageError").classList.add("hidden");
  image.src = roomImageUrl(keys[roomDetailsImageIndex]);
  image.alt = `${room.name} · Photo ${roomDetailsImageIndex + 1} sur ${keys.length}`;
  document.getElementById("roomDetailsCount").textContent = `${roomDetailsImageIndex + 1} / ${keys.length}`;
  document.getElementById("roomDetailsPrevious").disabled = keys.length < 2;
  document.getElementById("roomDetailsNext").disabled = keys.length < 2;
}

function openRoomDetails(id) {
  const room = getRoom(Number(id));
  if (!room) {
    showToast("Salle introuvable.", true);
    return;
  }
  roomDetailsId = room.id;
  roomDetailsImageIndex = state.roomGalleryIndexes[room.id] || 0;
  document.getElementById("roomDetailsTitle").textContent = room.name;
  const details = [
    ["Code", room.code],
    ["Type", room.type],
    ["Statut", room.active ? "Active" : "Inactive"],
    ["Capacité", `${room.capacity} personnes`],
    ["Emplacement", room.location || "Non renseigné"],
    ["Adresse", room.physicalAddress || "Non renseignée"],
    ["Horaires (CAT, UTC+2)", `${room.open}–${room.close}`],
    ["Durée maximale", `${room.maxDuration} h`],
    ["Équipements", room.equipment || "Aucun équipement renseigné"],
  ];
  document.getElementById("roomDetailsInfo").innerHTML = details.map(([label, value]) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
  ).join("");
  document.getElementById("roomDetailsReserve").classList.toggle("hidden", !room.active);
  updateRoomDetailsImage();
  document.getElementById("roomDetailsDialog").showModal();
}

function renderRooms() {
  const query = document.getElementById("roomSearch").value.trim().toLocaleLowerCase("fr");
  const status = document.getElementById("roomStatusFilter").value;
  const rooms = state.rooms.filter((room) => {
    const matchesStatus = status === "all" || (status === "active" ? room.active : !room.active);
    const searchText = `${room.name} ${room.code} ${room.location} ${room.type} ${room.equipment}`.toLocaleLowerCase("fr");
    return matchesStatus && searchText.includes(query);
  });
  const grid = document.getElementById("roomsGrid");
  grid.innerHTML = rooms.map((room) => {
    const todayCount = getActiveBookingsForRoom(room.id, dateToISO(new Date())).length;
    const imageKeys = getRoomImageKeys(room);
    const imageIndex = (state.roomGalleryIndexes[room.id] || 0) % imageKeys.length;
    const imageKey = imageKeys[imageIndex];
    const imageLabel = ROOM_GALLERY_IMAGES.find((image) => image.key === imageKey)?.label || "Photo de la salle";
    return `
      <article class="room-card ${room.active ? "" : "inactive-room"}">
        <div class="room-gallery">
          <button type="button" class="room-gallery-open" data-room-details="${room.id}" aria-label="Agrandir les photos et voir les détails de ${escapeHtml(room.name)}" aria-haspopup="dialog">
            <img src="${roomImageUrl(imageKey)}" alt="${escapeHtml(imageLabel)} · ${escapeHtml(room.name)}" loading="lazy" />
          </button>
          <span>${escapeHtml(room.type)}</span>
          ${imageKeys.length > 1 ? `
            <button type="button" class="room-gallery-arrow previous" data-room-image-move="${room.id}" data-direction="-1" aria-label="Photo précédente de ${escapeHtml(room.name)}">‹</button>
            <button type="button" class="room-gallery-arrow next" data-room-image-move="${room.id}" data-direction="1" aria-label="Photo suivante de ${escapeHtml(room.name)}">›</button>
            <span class="room-gallery-count">${imageIndex + 1} / ${imageKeys.length}</span>
          ` : ""}
        </div>
        ${imageKeys.length > 1 ? `<div class="room-gallery-thumbnails" aria-label="Photos de ${escapeHtml(room.name)}">
          ${imageKeys.map((key, index) => `
            <button type="button" class="room-gallery-thumb ${index === imageIndex ? "selected" : ""}" data-room-image-room="${room.id}" data-room-image-index="${index}" aria-label="Afficher la photo ${index + 1} de ${escapeHtml(room.name)}" aria-pressed="${index === imageIndex}">
              <img src="${roomImageUrl(key)}" alt="" loading="lazy" />
            </button>
          `).join("")}
        </div>` : ""}
        <header>
          <div><span class="room-code">${escapeHtml(room.code)} · ${escapeHtml(room.type)}</span><h3>${escapeHtml(room.name)}</h3></div>
          <span class="badge ${room.active ? "available" : "inactive"}">${room.active ? "Active" : "Inactive"}</span>
        </header>
        <p class="room-location">${escapeHtml(room.location || "Localisation non renseignée")}</p>
        ${room.physicalAddress ? `<p class="room-address"><strong>Adresse :</strong> ${escapeHtml(room.physicalAddress)}</p>` : ""}
        <div class="room-meta">
          <span>Capacité <strong>${Number(room.capacity)}</strong></span>
          <span>Horaires <strong>${escapeHtml(room.open)}–${escapeHtml(room.close)}</strong></span>
          <span>Aujourd’hui <strong>${todayCount} réservation${todayCount === 1 ? "" : "s"}</strong></span>
        </div>
        <p class="equipment">${escapeHtml(room.equipment || "Aucun équipement renseigné")}</p>
        ${room.active ? `<button type="button" class="room-book-btn" data-room-action="reserve" data-id="${room.id}">Réserver cette salle</button>` : ""}
        ${isManager() ? `<div class="room-actions">
          <button type="button" class="text-btn" data-room-action="edit" data-id="${room.id}">Modifier</button>
          <button type="button" class="text-btn" data-room-action="toggle" data-id="${room.id}">${room.active ? "Désactiver" : "Activer"}</button>
          <button type="button" class="text-btn danger-text" data-room-action="delete" data-id="${room.id}">Supprimer</button>
        </div>` : ""}
      </article>
    `;
  }).join("");
  if (rooms.length === 0) grid.innerHTML = '<p class="empty-state">Aucune salle trouvée.</p>';
  renderRoomOptions();
}

function renderRoomOptions() {
  const select = document.getElementById("roomSelect");
  const selected = select.value;
  const activeRooms = state.rooms.filter((room) => room.active);
  select.innerHTML = activeRooms.map((room) =>
    `<option value="${room.id}">${escapeHtml(room.name)} · ${Number(room.capacity)} places</option>`
  ).join("");
  if (activeRooms.some((room) => String(room.id) === selected)) select.value = selected;
  select.disabled = activeRooms.length === 0;
  document.getElementById("submitReservationBtn").disabled = activeRooms.length === 0;
  if (activeRooms.length === 0) select.innerHTML = '<option value="">Aucune salle active</option>';

  const calendarSelect = document.getElementById("calendarRoomFilter");
  const selectedRoom = calendarSelect.value;
  calendarSelect.innerHTML = '<option value="all">Toutes les salles</option>' + state.rooms.map((room) =>
    `<option value="${room.id}">${escapeHtml(room.name)}${room.active ? "" : " (inactive)"}</option>`
  ).join("");
  if ([...calendarSelect.options].some((option) => option.value === selectedRoom)) calendarSelect.value = selectedRoom;
}

function getSortedReservations() {
  return [...state.reservations].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

function renderBookings() {
  const search = document.getElementById("bookingSearch").value.trim().toLocaleLowerCase("fr");
  const status = document.getElementById("bookingStatusFilter").value;
  const period = document.getElementById("bookingPeriodFilter").value;
  const today = dateToISO(new Date());
  const bookings = getSortedReservations().filter((booking) => {
    const matchesSearch = `${booking.title} ${booking.eventType} ${booking.owner} ${getRoomName(booking.roomId)}`.toLocaleLowerCase("fr").includes(search);
    const matchesStatus = status === "all" || booking.status === status;
    const matchesPeriod = period === "all" || (period === "past" ? booking.date < today : booking.date >= today);
    return matchesSearch && matchesStatus && matchesPeriod;
  });
  const table = document.getElementById("bookingTable");
  table.innerHTML = bookings.map((booking) => {
    const canEdit = canManageReservation(booking) && booking.date >= today && booking.status !== "annulé" && booking.status !== "refusé";
    const canReview = isManager() && booking.status === "en attente";
    const actions = [
      canManageReservation(booking) ? `<button class="action-btn" data-booking-action="ticket" data-id="${booking.id}">Ticket</button>` : "",
      canReview ? `<button class="action-btn approve" data-booking-action="approve" data-id="${booking.id}">Valider</button><button class="action-btn reject" data-booking-action="reject" data-id="${booking.id}">Refuser</button>` : "",
      canEdit ? `<button class="action-btn" data-booking-action="edit" data-id="${booking.id}">Modifier</button><button class="action-btn reject" data-booking-action="cancel" data-id="${booking.id}">Annuler</button>` : "",
      !canManageReservation(booking) ? '<span class="muted">—</span>' : "",
    ].join("");
    return `<tr>
      <td data-label="Salle / date"><strong>${escapeHtml(getRoomName(booking.roomId))}</strong><small>${formatDate(booking.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</small></td>
      <td data-label="Objet">${escapeHtml(booking.title)}<small>${escapeHtml(booking.eventType || "Réunion")}</small>${booking.comment ? `<small>${escapeHtml(booking.comment)}</small>` : ""}</td>
      <td data-label="Demandeur">${escapeHtml(booking.owner)}<small>${Number(booking.guests)} participant${Number(booking.guests) === 1 ? "" : "s"}</small></td>
      <td data-label="Horaire">${escapeHtml(booking.start)}–${escapeHtml(booking.end)}</td>
      <td data-label="Statut"><span class="status-pill ${statusClass(booking.status)}">${escapeHtml(booking.status)}</span></td>
      <td class="actions-cell" data-label="Actions">${actions}</td>
    </tr>`;
  }).join("");
  document.getElementById("bookingEmpty").classList.toggle("hidden", bookings.length > 0);
}

function statusClass(status) {
  if (status === "confirmé") return "confirmed";
  if (status === "en attente") return "pending";
  if (status === "refusé") return "rejected";
  return "cancelled";
}

function renderCalendar() {
  const date = state.calendarDate;
  const [year, month, day] = date.split("-").map(Number);
  const view = state.calendarView;
  const roomFilter = document.getElementById("calendarRoomFilter").value;
  const grid = document.getElementById("calendarGrid");
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.view === view);
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
  let days;
  if (view === "day") {
    days = [date];
    document.getElementById("calendarPeriod").textContent = formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } else if (view === "week") {
    const first = new Date(Date.UTC(year, month - 1, day));
    const weekStart = shiftDate(date, -((first.getUTCDay() + 6) % 7));
    days = Array.from({ length: 7 }, (_, index) => shiftDate(weekStart, index));
    document.getElementById("calendarPeriod").textContent = `${formatDate(days[0], { day: "numeric", month: "long" })} – ${formatDate(days[6], { day: "numeric", month: "long", year: "numeric" })}`;
  } else {
    const monthStart = `${date.slice(0, 7)}-01`;
    const firstDay = new Date(`${monthStart}T00:00:00.000Z`);
    const gridStart = shiftDate(monthStart, -((firstDay.getUTCDay() + 6) % 7));
    days = Array.from({ length: 42 }, (_, index) => shiftDate(gridStart, index));
    document.getElementById("calendarPeriod").textContent = formatDate(monthStart, { month: "long", year: "numeric" });
  }
  const headers = view === "month" ? '<div class="weekday">Lun.</div><div class="weekday">Mar.</div><div class="weekday">Mer.</div><div class="weekday">Jeu.</div><div class="weekday">Ven.</div><div class="weekday">Sam.</div><div class="weekday">Dim.</div>' : "";
  const today = dateToISO(new Date());
  grid.className = `calendar-grid ${view}-view`;
  grid.innerHTML = headers + days.map((calendarDay) => {
    const dayBookings = getSortedReservations().filter((booking) =>
      booking.date === calendarDay &&
      ACTIVE_STATUSES.has(booking.status) &&
      (roomFilter === "all" || booking.roomId === Number(roomFilter))
    );
    const outsideMonth = view === "month" && calendarDay.slice(0, 7) !== `${year}-${String(month).padStart(2, "0")}`;
    const bookingsMarkup = dayBookings.map((booking) =>
      `<button type="button" class="calendar-booking ${statusClass(booking.status)}" data-calendar-booking="${booking.id}" title="${escapeHtml(booking.title)} · ${escapeHtml(booking.start)}–${escapeHtml(booking.end)}">
        <strong>${escapeHtml(booking.start)} · ${escapeHtml(getRoomName(booking.roomId))}</strong><span>${escapeHtml(booking.eventType || "Réunion")} · ${escapeHtml(booking.title)}</span>
      </button>`
    ).join("");
    return `<article class="calendar-day ${outsideMonth ? "outside-month" : ""} ${calendarDay === today ? "is-today" : ""} ${view === "day" ? "single-day" : ""}">
      <button type="button" class="day-number" data-calendar-date="${calendarDay}" aria-label="Afficher les réservations du ${formatDate(calendarDay, { day: "numeric", month: "long", year: "numeric" })}">${view === "day" ? formatDate(calendarDay, { weekday: "long", day: "numeric", month: "long" }) : Number(calendarDay.slice(-2))}</button>
      <div class="day-bookings">${bookingsMarkup || '<span class="free-label">Libre</span>'}</div>
    </article>`;
  }).join("");
}

function renderReports() {
  if (state.role !== "Administrateur") {
    document.getElementById("auditTable").replaceChildren();
    for (const id of ["monthlyBookings", "monthlyHours", "occupancyRate", "closedBookings"]) {
      document.getElementById(id).textContent = "";
    }
    return;
  }
  const monthPrefix = dateToISO().slice(0, 7);
  const [year, month] = monthPrefix.split("-").map(Number);
  const monthBookings = state.reservations.filter((booking) => booking.date.startsWith(monthPrefix));
  const activeMonthBookings = monthBookings.filter((booking) => ACTIVE_STATUSES.has(booking.status));
  const bookedMinutes = activeMonthBookings.reduce((sum, booking) => sum + timeToMinutes(booking.end) - timeToMinutes(booking.start), 0);
  const activeRoomCount = state.rooms.filter((room) => room.active).length;
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const availableMinutes = activeRoomCount * monthDays * 8 * 60;
  document.getElementById("monthlyBookings").textContent = String(monthBookings.length);
  document.getElementById("monthlyHours").textContent = `${(bookedMinutes / 60).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h`;
  document.getElementById("occupancyRate").textContent = `${availableMinutes ? Math.min(100, Math.round(bookedMinutes / availableMinutes * 100)) : 0} %`;
  document.getElementById("closedBookings").textContent = String(monthBookings.filter((booking) => booking.status === "annulé" || booking.status === "refusé").length);
  const auditTable = document.getElementById("auditTable");
  auditTable.innerHTML = state.logs.slice(0, 20).map((entry) =>
    `<tr><td>${formatDateTime(entry.at)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.detail)}</td><td>${escapeHtml(entry.actor || entry.role)}</td></tr>`
  ).join("");
  document.getElementById("auditEmpty").classList.toggle("hidden", state.logs.length > 0);
}

function renderNotifications() {
  const count = Number(state.unreadNotificationCount);
  const badge = document.getElementById("notificationNavCount");
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  document.getElementById("markAllNotificationsReadBtn").disabled = count === 0;
  const list = document.getElementById("notificationsList");
  list.innerHTML = (state.role === "Administrateur" ? state.notifications : []).map((notification) => `
    <article class="notification-item ${notification.readAt ? "" : "unread"}">
      <div>
        <h3>${escapeHtml(notification.title)}</h3>
        <p>${escapeHtml(notification.message)}</p>
        <time datetime="${escapeHtml(notification.createdAt)}">${formatDateTime(notification.createdAt, { dateStyle: "medium", timeStyle: "short" })}</time>
      </div>
      ${notification.readAt ? '<span class="notification-read-label">Lue</span>' : `<button class="action-btn" type="button" data-notification-read="${notification.id}">Marquer comme lue</button>`}
    </article>
  `).join("");
  document.getElementById("notificationsEmpty").classList.toggle("hidden", state.notifications.length > 0);
}

function renderIdentity() {
  document.getElementById("roleLabel").textContent = state.role;
  document.getElementById("userNameLabel").textContent = state.userName;
  document.getElementById("userAvatar").textContent = state.userName.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toLocaleUpperCase("fr");
  document.getElementById("reservationOwner").value = state.userName;
  document.querySelectorAll(".manager-only").forEach((element) => element.classList.toggle("hidden", !isManager()));
  document.getElementById("roomPermissionNote").classList.toggle("hidden", isManager());
  document.getElementById("usersSection").classList.toggle("hidden", state.role !== "Administrateur");
  document.getElementById("organizationSection").classList.toggle("hidden", state.role !== "Administrateur");
  document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", state.role !== "Administrateur"));
}

function renderOrganizationSettings() {
  document.getElementById("organizationAddress").value = state.organization.physicalAddress;
  document.getElementById("organizationReferences").value = state.organization.referenceDetails;
}

async function handleOrganizationSubmit(event) {
  event.preventDefault();
  if (state.role !== "Administrateur") return;
  const button = document.getElementById("saveOrganizationBtn");
  button.disabled = true;
  try {
    const result = await apiRequest("/api/settings/organization", {
      method: "PUT",
      body: {
        physicalAddress: document.getElementById("organizationAddress").value.trim(),
        referenceDetails: document.getElementById("organizationReferences").value.trim(),
      },
    });
    state.organization = result.organization;
    renderOrganizationSettings();
    showToast("Coordonnées de l’établissement enregistrées. Elles apparaîtront sur les prochains tickets.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderUsers() {
  const table = document.getElementById("usersTable");
  table.innerHTML = users.map((user) => `<tr>
    <td>${escapeHtml(user.name)}</td>
    <td>${escapeHtml(user.email)}</td>
    <td><select data-user-role="${user.id}" aria-label="Rôle de ${escapeHtml(user.name)}">
      ${["Utilisateur", "Gestionnaire", "Administrateur"].map((role) => `<option${role === user.role ? " selected" : ""}>${role}</option>`).join("")}
    </select></td>
    <td><span class="status-pill ${user.active ? "confirmed" : "cancelled"}">${user.active ? "Actif" : "Désactivé"}</span></td>
    <td><button class="action-btn" data-user-active="${user.id}" data-active="${!user.active}">${user.active ? "Désactiver" : "Activer"}</button></td>
  </tr>`).join("");
}

function render() {
  renderIdentity();
  renderStats();
  renderRooms();
  renderBookings();
  renderCalendar();
  renderReports();
  renderNotifications();
  renderUsers();
  renderOrganizationSettings();
  document.getElementById("todayLabel").textContent = formatDateTime(new Date(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function setupShowcase() {
  const slides = [...document.querySelectorAll(".showcase-slide")];
  const dots = [...document.querySelectorAll(".showcase-dot")];
  const pauseButton = document.getElementById("showcasePause");
  const announcement = document.getElementById("showcaseAnnouncement");
  const showcase = document.querySelector(".showcase");
  const appShell = document.getElementById("appShell");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let activeIndex = 0;
  let timer;
  let paused = reducedMotion.matches;

  function showSlide(index, announce = false) {
    activeIndex = (index + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === activeIndex;
      slide.classList.toggle("active", active);
      slide.setAttribute("aria-hidden", String(!active));
      dots[slideIndex].classList.toggle("active", active);
      if (active) dots[slideIndex].setAttribute("aria-current", "true");
      else dots[slideIndex].removeAttribute("aria-current");
    });
    if (announce) announcement.textContent = `Photo ${activeIndex + 1} sur ${slides.length}`;
  }

  function stopTimer() {
    window.clearInterval(timer);
    timer = undefined;
  }

  function startTimer() {
    stopTimer();
    if (!paused && !document.hidden && !appShell.classList.contains("hidden") && slides.length > 1) {
      timer = window.setInterval(() => showSlide(activeIndex + 1), 6500);
    }
  }

  function setPaused(value) {
    paused = value;
    pauseButton.setAttribute("aria-pressed", String(paused));
    pauseButton.setAttribute("aria-label", paused ? "Reprendre le diaporama" : "Mettre le diaporama en pause");
    pauseButton.querySelector("span").textContent = paused ? "▶" : "Ⅱ";
    startTimer();
  }

  document.getElementById("showcasePrevious").addEventListener("click", () => {
    showSlide(activeIndex - 1, true);
    startTimer();
  });
  document.getElementById("showcaseNext").addEventListener("click", () => {
    showSlide(activeIndex + 1, true);
    startTimer();
  });
  dots.forEach((dot, index) => dot.addEventListener("click", () => {
    showSlide(index, true);
    startTimer();
  }));
  pauseButton.addEventListener("click", () => setPaused(!paused));
  showcase.addEventListener("focusin", () => setPaused(true));
  reducedMotion.addEventListener("change", (event) => setPaused(event.matches));
  document.addEventListener("visibilitychange", startTimer);
  setPaused(paused);
  return startTimer;
}

const refreshShowcaseTimer = setupShowcase();

function updateRecurrenceFields() {
  const recurrence = document.getElementById("recurrence").value;
  const hasInterval = recurrence === "hourly" || recurrence === "daily";
  document.getElementById("occurrencesField").classList.toggle("hidden", recurrence === "none");
  document.getElementById("recurrenceIntervalField").classList.toggle("hidden", !hasInterval);
  document.getElementById("recurrenceInterval").disabled = !hasInterval;
  document.getElementById("recurrenceInterval").required = hasInterval;
  document.getElementById("recurrenceIntervalLabel").textContent = recurrence === "hourly" ? "Intervalle en heures" : "Intervalle en jours";
}

function resetReservationForm() {
  document.getElementById("reservationForm").reset();
  document.getElementById("reservationId").value = "";
  document.getElementById("reservationEventType").value = "Réunion";
  document.getElementById("reservationPaymentMethod").value = "À payer";
  document.getElementById("reservationPaymentStatus").value = "Non demandé";
  document.getElementById("reservationAmount").value = "0";
  document.getElementById("reservationCurrency").value = "CDF";
  dateInput.min = dateToISO(new Date());
  dateInput.value = dateToISO(new Date());
  document.getElementById("reservationOwner").value = state.userName;
  document.getElementById("reservationGuests").value = "2";
  document.getElementById("reservationFormTitle").textContent = "Réserver une salle";
  document.getElementById("submitReservationBtn").textContent = "Envoyer la demande";
  document.getElementById("cancelEditBtn").classList.add("hidden");
  document.getElementById("recurrence").disabled = false;
  updateRecurrenceFields();
}

function openRoomModal(room = null) {
  if (!isManager() || roomFormSaving) return;
  const form = document.getElementById("roomForm");
  form.reset();
  document.getElementById("roomId").value = room?.id || "";
  document.getElementById("roomModalTitle").textContent = room ? "Modifier la salle" : "Ajouter une salle";
  document.getElementById("newRoomName").value = room?.name || "";
  document.getElementById("newRoomCode").value = room?.code || "";
  document.getElementById("newRoomType").value = room?.type || "Réunion";
  document.getElementById("newRoomCapacity").value = room?.capacity || 12;
  document.getElementById("newRoomEquip").value = room?.equipment || "";
  document.getElementById("newRoomLocation").value = room?.location || "";
  document.getElementById("newRoomPhysicalAddress").value = room?.physicalAddress || "";
  document.getElementById("newRoomReferences").value = room?.referenceDetails || "";
  document.getElementById("newRoomOpen").value = room?.open || "08:00";
  document.getElementById("newRoomClose").value = room?.close || "20:00";
  document.getElementById("newRoomMaxDuration").value = room?.maxDuration || 4;
  document.getElementById("newRoomActive").checked = room ? room.active : true;
  const selectedImages = Array.isArray(room?.imageKeys) ? room.imageKeys : [room?.imageKey || "boardroom"];
  document.querySelectorAll('input[name="roomImageKeys"]').forEach((input) => {
    input.checked = selectedImages.includes(input.value);
  });
  roomPhotoItems.forEach((item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  });
  roomPhotoItems = (room?.imageKeys || [])
    .filter(isUploadedRoomImageKey)
    .map((key) => ({ key, file: null, name: "Photo déjà enregistrée", previewUrl: "", selected: true }));
  renderRoomUploadPreviews();
  const modal = document.getElementById("roomModal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("newRoomName").focus();
}

function closeRoomModal() {
  if (roomFormSaving) return;
  const modal = document.getElementById("roomModal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  const usedPhotoKeys = new Set(state.rooms.flatMap((room) => room.imageKeys || []));
  const unusedKeys = roomPhotoItems
    .filter((item) => item.key && !usedPhotoKeys.has(item.key))
    .map((item) => item.key);
  roomPhotoItems.forEach((item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  });
  roomPhotoItems = [];
  renderRoomUploadPreviews();
  unusedKeys.forEach((key) => {
    apiRequest(`/api/room-images/${encodeURIComponent(key)}`, { method: "DELETE" })
      .catch((error) => showToast(`La photo temporaire n’a pas pu être supprimée : ${error.message}`, true));
  });
}

function renderRoomUploadPreviews() {
  const container = document.getElementById("roomUploadedPhotos");
  container.innerHTML = roomPhotoItems.map((item, index) => {
    const src = item.previewUrl || (item.key ? roomImageUrl(item.key) : "");
    return `
      <div class="room-upload-card">
        <label class="room-image-option room-upload-option">
          <input type="checkbox" name="roomUploadKeys" data-room-photo-index="${index}" ${item.selected ? "checked" : ""} />
          <img src="${escapeHtml(src)}" alt="" />
          <span>${escapeHtml(item.name)}</span>
        </label>
        <button class="text-btn danger-text" type="button" data-room-photo-remove="${index}">Retirer</button>
      </div>
    `;
  }).join("");
}

function validateReservation(roomId, date, start, end, guests, exceptId = null) {
  const room = getRoom(roomId);
  if (!room || !room.active) return "Cette salle est inactive ou n’existe plus.";
  if (date < dateToISO(new Date())) return "Une réservation ne peut pas être créée dans le passé.";
  if (timeToMinutes(start) >= timeToMinutes(end)) return "L’heure de fin doit être après l’heure de début.";
  if (timeToMinutes(start) < timeToMinutes(room.open) || timeToMinutes(end) > timeToMinutes(room.close)) {
    return `Les réservations de cette salle sont autorisées de ${room.open} à ${room.close}.`;
  }
  if (timeToMinutes(end) - timeToMinutes(start) > Number(room.maxDuration) * 60) {
    return `La durée maximale autorisée pour cette salle est de ${room.maxDuration} h.`;
  }
  if (Number(guests) > Number(room.capacity)) return `La capacité de cette salle est limitée à ${room.capacity} personnes.`;
  if (getActiveBookingsForRoom(roomId, date, exceptId).some((booking) =>
    timeToMinutes(start) < timeToMinutes(booking.end) && timeToMinutes(end) > timeToMinutes(booking.start)
  )) return "Conflit : cette salle est déjà réservée sur cette plage horaire.";
  return "";
}

async function handleReservationSubmit(event) {
  event.preventDefault();
  const idValue = document.getElementById("reservationId").value;
  const roomId = Number(document.getElementById("roomSelect").value);
  const date = dateInput.value;
  const start = document.getElementById("startTime").value;
  const end = document.getElementById("endTime").value;
  const title = document.getElementById("reservationTitle").value.trim();
  const eventType = document.getElementById("reservationEventType").value;
  const guests = Number(document.getElementById("reservationGuests").value);
  const comment = document.getElementById("reservationComment").value.trim();
  if (!roomId || !date || !start || !end || !title || !Number.isInteger(guests) || guests < 1) {
    showToast("Vérifiez les champs obligatoires et le nombre de participants.", true);
    return;
  }
  const current = idValue ? state.reservations.find((booking) => booking.id === Number(idValue)) : null;
  if (current && !canManageReservation(current)) {
    showToast("Vous ne pouvez modifier que vos propres réservations.", true);
    return;
  }
  const recurrence = document.getElementById("recurrence").value;
  const occurrenceCount = recurrence === "none" || current ? 1 : Number(document.getElementById("occurrences").value);
  if (!Number.isInteger(occurrenceCount) || occurrenceCount < 1 || occurrenceCount > 12) {
    showToast("Le nombre de séances doit être compris entre 1 et 12.", true);
    return;
  }
  const recurrenceInterval = ["hourly", "daily"].includes(recurrence) ? Number(document.getElementById("recurrenceInterval").value) : 1;
  if (!Number.isSafeInteger(recurrenceInterval) || recurrenceInterval < 1) {
    showToast("L’intervalle de récurrence doit être un nombre entier positif.", true);
    return;
  }
  const paymentMethod = document.getElementById("reservationPaymentMethod")?.value || "À payer";
  const paymentStatus = document.getElementById("reservationPaymentStatus")?.value || "Non demandé";
  const amount = Number(document.getElementById("reservationAmount")?.value || 0);
  const currency = document.getElementById("reservationCurrency")?.value || "CDF";
  const bookingData = { roomId, date, start, end, title, eventType, guests, comment, paymentMethod, paymentStatus, amount, currency };
  try {
    if (current) {
      await mutateAndRefresh(`/api/reservations/${current.id}`, "PUT", bookingData);
      showToast("Réservation modifiée.");
    } else {
      const result = await apiRequest("/api/reservations", {
        method: "POST",
        body: { ...bookingData, recurrence, occurrences: occurrenceCount, recurrenceInterval },
      });
      resetReservationForm();
      showReservationTicket(result.reservations);
      try {
        await loadWorkspace();
      } catch (refreshError) {
        showToast(`La demande est enregistrée et le ticket est délivré, mais l’actualisation a échoué : ${refreshError.message}`, true);
      }
      return;
    }
    resetReservationForm();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleRoomSubmit(event) {
  event.preventDefault();
  if (!isManager() || roomFormSaving) return;
  const idValue = document.getElementById("roomId").value;
  const name = document.getElementById("newRoomName").value.trim();
  const code = document.getElementById("newRoomCode").value.trim();
  const open = document.getElementById("newRoomOpen").value;
  const close = document.getElementById("newRoomClose").value;
  const capacity = Number(document.getElementById("newRoomCapacity").value);
  const maxDuration = Number(document.getElementById("newRoomMaxDuration").value);
  const selectedStaticImages = [...document.querySelectorAll('input[name="roomImageKeys"]:checked')].map((input) => input.value);
  const selectedUploadedPhotos = roomPhotoItems.filter((item) => item.selected);
  if (!name || !code || timeToMinutes(open) >= timeToMinutes(close) || capacity < 1 || maxDuration < 1) {
    showToast("Vérifiez les informations de la salle et ses horaires.", true);
    return;
  }
  if (selectedStaticImages.length + selectedUploadedPhotos.length < 1 ||
      selectedStaticImages.length + selectedUploadedPhotos.length > ROOM_GALLERY_IMAGES.length) {
    showToast(`Choisissez entre 1 et ${ROOM_GALLERY_IMAGES.length} photos au total pour la galerie.`, true);
    return;
  }
  const duplicate = state.rooms.some((room) =>
    room.id !== Number(idValue) &&
    (room.code.toLocaleLowerCase("fr") === code.toLocaleLowerCase("fr") || room.name.toLocaleLowerCase("fr") === name.toLocaleLowerCase("fr"))
  );
  if (duplicate) {
    showToast("Une salle porte déjà ce nom ou ce code.", true);
    return;
  }
  roomFormSaving = true;
  const saveButton = document.querySelector("#roomForm button[type='submit']");
  saveButton.disabled = true;
  saveButton.textContent = "Enregistrement en cours…";
  try {
    const previousRoom = idValue ? getRoom(idValue) : null;
    for (const item of selectedUploadedPhotos) {
      if (!item.file) continue;
      const upload = await apiRequest("/api/room-images", {
        method: "POST",
        headers: { "Content-Type": item.file.type },
        body: item.file,
        rawBody: true,
      });
      if (!isUploadedRoomImageKey(upload.key)) throw new ApiError(500, "Le serveur a retourné un identifiant de photo invalide.");
      item.key = upload.key;
      item.file = null;
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      item.previewUrl = "";
      renderRoomUploadPreviews();
    }
    const imageKeys = [
      ...selectedStaticImages,
      ...selectedUploadedPhotos.map((item) => item.key),
    ];
    const roomData = {
      name,
      code,
      type: document.getElementById("newRoomType").value,
      capacity,
      equipment: document.getElementById("newRoomEquip").value.trim(),
      location: document.getElementById("newRoomLocation").value.trim(),
      physicalAddress: document.getElementById("newRoomPhysicalAddress").value.trim(),
      referenceDetails: document.getElementById("newRoomReferences").value.trim(),
      open,
      close,
      maxDuration,
      active: document.getElementById("newRoomActive").checked,
      imageKeys,
    };
    if (idValue) {
      await mutateAndRefresh(`/api/rooms/${idValue}`, "PUT", roomData);
      showToast("Salle modifiée.");
    } else {
      await mutateAndRefresh("/api/rooms", "POST", roomData);
      showToast("Salle ajoutée.");
    }
    const retainedPhotoKeys = new Set(imageKeys);
    const photoKeysNoLongerUsed = new Set([
      ...(previousRoom?.imageKeys || []),
      ...roomPhotoItems.filter((item) => item.key).map((item) => item.key),
    ]);
    const roomPhotoKeysInUse = new Set(state.rooms.flatMap((room) => room.imageKeys || []));
    for (const key of photoKeysNoLongerUsed) {
      if (retainedPhotoKeys.has(key) || roomPhotoKeysInUse.has(key)) continue;
      try {
        await apiRequest(`/api/room-images/${encodeURIComponent(key)}`, { method: "DELETE" });
      } catch (error) {
        showToast(`La salle est enregistrée, mais une ancienne photo n’a pas pu être supprimée : ${error.message}`, true);
      }
    }
    roomPhotoItems.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    roomPhotoItems = [];
    renderRoomUploadPreviews();
    document.getElementById("roomForm").reset();
    roomFormSaving = false;
    closeRoomModal();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    roomFormSaving = false;
    saveButton.disabled = false;
    saveButton.textContent = "Enregistrer la salle";
  }
}

function startEditReservation(id) {
  const booking = state.reservations.find((item) => item.id === Number(id));
  if (!booking || !canManageReservation(booking) || booking.date < dateToISO(new Date())) return;
  document.getElementById("reservationId").value = booking.id;
  document.getElementById("roomSelect").value = String(booking.roomId);
  dateInput.value = booking.date;
  dateInput.min = dateToISO(new Date());
  document.getElementById("reservationTitle").value = booking.title;
  document.getElementById("reservationEventType").value = booking.eventType || "Réunion";
  document.getElementById("startTime").value = booking.start;
  document.getElementById("endTime").value = booking.end;
  document.getElementById("reservationOwner").value = booking.owner;
  document.getElementById("reservationGuests").value = booking.guests;
  document.getElementById("reservationComment").value = booking.comment || "";
  document.getElementById("reservationPaymentMethod").value = booking.paymentMethod || "À payer";
  document.getElementById("reservationPaymentStatus").value = booking.paymentStatus || "Non demandé";
  document.getElementById("reservationAmount").value = String(Number(booking.amount || 0));
  document.getElementById("reservationCurrency").value = booking.currency || "CDF";
  document.getElementById("reservationFormTitle").textContent = "Modifier la réservation";
  document.getElementById("submitReservationBtn").textContent = "Enregistrer les changements";
  document.getElementById("cancelEditBtn").classList.remove("hidden");
  document.getElementById("recurrence").value = "none";
  document.getElementById("recurrence").disabled = true;
  updateRecurrenceFields();
  document.getElementById("reservationSection").scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("reservationTitle").focus({ preventScroll: true });
}

async function handleBookingAction(action, id) {
  const booking = state.reservations.find((item) => item.id === Number(id));
  if (!booking) return;
  if (action === "ticket") {
    if (!canManageReservation(booking)) return;
    showReservationTicket([booking]);
    return;
  }
  if (action === "edit") {
    startEditReservation(id);
    return;
  }
  try {
    if (action === "approve" || action === "reject") {
      await mutateAndRefresh(`/api/reservations/${id}/status`, "PATCH", { status: action === "approve" ? "confirmé" : "refusé" });
      showToast(action === "approve" ? "Réservation confirmée." : "Demande refusée.");
    } else if (action === "cancel") {
      if (!canManageReservation(booking) || booking.date < dateToISO(new Date()) || !ACTIVE_STATUSES.has(booking.status)) return;
      const reason = window.prompt("Motif d’annulation (facultatif) :", "");
      if (reason === null) return;
      await mutateAndRefresh(`/api/reservations/${id}/cancel`, "POST", { reason: reason.trim() });
      showToast("Réservation annulée.");
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleRoomAction(action, id) {
  const room = getRoom(id);
  if (!room) return;
  if (action === "reserve") {
    if (!room.active) return;
    document.getElementById("roomSelect").value = String(room.id);
    document.getElementById("reservationSection").scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("reservationDate").focus({ preventScroll: true });
    return;
  }
  if (!isManager()) return;
  if (action === "edit") {
    openRoomModal(room);
    return;
  }
  if (action === "toggle") {
    try {
      await mutateAndRefresh(`/api/rooms/${id}/active`, "PATCH", { active: !room.active });
      showToast(room.active ? "Salle désactivée." : "Salle activée.");
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }
  if (action === "delete") {
    if (!window.confirm(`Supprimer définitivement ${room.name} ?`)) return;
    try {
      await mutateAndRefresh(`/api/rooms/${id}`, "DELETE");
      showToast("Salle supprimée.");
    } catch (error) {
      showToast(error.message, true);
    }
  }
}

function moveCalendar(amount) {
  const unit = state.calendarView === "month" ? "month" : state.calendarView === "week" ? "day" : "day";
  const increment = state.calendarView === "week" ? amount * 7 : amount;
  state.calendarDate = shiftDate(state.calendarDate, increment, unit);
  renderCalendar();
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportReservations() {
  if (state.role !== "Administrateur") {
    showToast("L’export CSV est réservé aux administrateurs.", true);
    return;
  }
  const rows = [
    ["Salle", "Code", "Date", "Début", "Fin", "Objet", "Type d’événement", "Demandeur", "Participants", "Statut", "Commentaire"],
    ...getSortedReservations().map((booking) => {
      const room = getRoom(booking.roomId);
      return [room?.name || "Salle supprimée", room?.code || "", booking.date, booking.start, booking.end, booking.title, booking.eventType || "Réunion", booking.owner, booking.guests, booking.status, booking.comment || ""];
    }),
  ];
  const content = "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `roomflow-reservations-${dateToISO(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Export CSV téléchargé.");
}

document.getElementById("reservationForm").addEventListener("submit", handleReservationSubmit);
document.getElementById("organizationForm").addEventListener("submit", handleOrganizationSubmit);
document.getElementById("closeTicketBtn").addEventListener("click", closeReservationTicket);
document.getElementById("doneTicketBtn").addEventListener("click", closeReservationTicket);
document.getElementById("downloadTicketPdfBtn").addEventListener("click", downloadReservationTicketPdf);
document.getElementById("printTicketBtn").addEventListener("click", () => window.print());
document.querySelectorAll("[data-close-ticket]").forEach((element) => element.addEventListener("click", closeReservationTicket));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("ticketModal").classList.contains("hidden")) {
    closeReservationTicket();
  }
});
document.getElementById("roomForm").addEventListener("submit", handleRoomSubmit);
document.getElementById("addRoomBtn").addEventListener("click", () => openRoomModal());
document.getElementById("closeRoomModalBtn").addEventListener("click", closeRoomModal);
document.querySelectorAll("[data-close-modal]").forEach((element) => element.addEventListener("click", closeRoomModal));
document.getElementById("roomPhotoFiles").addEventListener("change", (event) => {
  const input = event.currentTarget;
  let selectedCount = document.querySelectorAll('input[name="roomImageKeys"]:checked').length +
    roomPhotoItems.filter((item) => item.selected).length;
  for (const file of input.files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      showToast(`${file.name} : choisissez une image JPEG, PNG ou WebP.`, true);
      continue;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast(`${file.name} dépasse la limite de 5 Mo.`, true);
      continue;
    }
    if (selectedCount >= ROOM_GALLERY_IMAGES.length) {
      showToast(`La galerie est limitée à ${ROOM_GALLERY_IMAGES.length} photos.`, true);
      break;
    }
    roomPhotoItems.push({
      file,
      key: "",
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      selected: true,
    });
    selectedCount += 1;
  }
  input.value = "";
  renderRoomUploadPreviews();
});
document.querySelector(".room-image-options").addEventListener("change", (event) => {
  if (!event.target.matches('input[name="roomImageKeys"]:checked')) return;
  const total = document.querySelectorAll('input[name="roomImageKeys"]:checked').length +
    roomPhotoItems.filter((item) => item.selected).length;
  if (total > ROOM_GALLERY_IMAGES.length) {
    event.target.checked = false;
    showToast(`La galerie est limitée à ${ROOM_GALLERY_IMAGES.length} photos.`, true);
  }
});
document.getElementById("roomUploadedPhotos").addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[name="roomUploadKeys"]');
  if (!checkbox) return;
  const item = roomPhotoItems[Number(checkbox.dataset.roomPhotoIndex)];
  if (!item) return;
  const selectedStaticCount = document.querySelectorAll('input[name="roomImageKeys"]:checked').length;
  const otherSelectedUploads = roomPhotoItems.filter((photo, index) => index !== Number(checkbox.dataset.roomPhotoIndex) && photo.selected).length;
  if (checkbox.checked && selectedStaticCount + otherSelectedUploads >= ROOM_GALLERY_IMAGES.length) {
    checkbox.checked = false;
    showToast(`La galerie est limitée à ${ROOM_GALLERY_IMAGES.length} photos.`, true);
    return;
  }
  item.selected = checkbox.checked;
});
document.getElementById("roomUploadedPhotos").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-room-photo-remove]");
  if (!button) return;
  const index = Number(button.dataset.roomPhotoRemove);
  const [item] = roomPhotoItems.splice(index, 1);
  if (!item) return;
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  renderRoomUploadPreviews();
  const isInUse = state.rooms.some((room) => room.imageKeys?.includes(item.key));
  if (item.key && !isInUse) {
    try {
      await apiRequest(`/api/room-images/${encodeURIComponent(item.key)}`, { method: "DELETE" });
    } catch (error) {
      showToast(`La photo n’a pas pu être supprimée : ${error.message}`, true);
    }
  }
});
document.getElementById("cancelEditBtn").addEventListener("click", resetReservationForm);
document.getElementById("exportCsvBtn").addEventListener("click", exportReservations);
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-password-toggle]");
  if (!button) return;
  const input = button.closest(".password-field")?.querySelector("input");
  if (!input) return;
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", visible ? "Masquer le mot de passe" : "Afficher le mot de passe");
});
document.getElementById("showLoginButton").addEventListener("click", () => {
  showLoginForm();
  document.getElementById("loginEmail").focus();
});
document.getElementById("showRegisterButton").addEventListener("click", () => {
  showAccountForm();
  document.getElementById("setupName").focus();
});
document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("loginError");
  const button = document.getElementById("loginButton");
  error.classList.add("hidden");
  button.disabled = true;
  document.getElementById("showRegisterButton").disabled = true;
  try {
    const session = await apiRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: document.getElementById("loginEmail").value.trim(),
        password: document.getElementById("loginPassword").value,
      },
    });
    csrfToken = session.csrfToken;
    await loadWorkspace();
    document.getElementById("authScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    refreshShowcaseTimer();
    document.getElementById("loginPassword").value = "";
  } catch (loginError) {
    error.textContent = loginError.message;
    error.classList.remove("hidden");
    document.getElementById("loginPassword").value = "";
  } finally {
    button.disabled = false;
    document.getElementById("showRegisterButton").disabled = false;
  }
});
document.getElementById("setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("setupError");
  const button = document.getElementById("setupButton");
  const password = document.getElementById("setupPassword").value;
  const initialSetup = authMode === "setup";
  error.classList.add("hidden");
  if (password !== document.getElementById("setupConfirmPassword").value) {
    error.textContent = "Les mots de passe ne correspondent pas.";
    error.classList.remove("hidden");
    return;
  }
  button.disabled = true;
  document.getElementById("showLoginButton").disabled = true;
  document.getElementById("showRegisterButton").disabled = true;
  try {
    const session = await apiRequest(initialSetup ? "/api/auth/setup" : "/api/auth/register", {
      method: "POST",
      body: {
        name: document.getElementById("setupName").value.trim(),
        email: document.getElementById("setupEmail").value.trim(),
        password,
      },
    });
    csrfToken = session.csrfToken;
    await loadWorkspace();
    document.getElementById("authScreen").classList.add("hidden");
    document.getElementById("appShell").classList.remove("hidden");
    refreshShowcaseTimer();
    document.getElementById("setupForm").reset();
  } catch (setupError) {
    error.textContent = setupError.message;
    error.classList.remove("hidden");
    if (initialSetup && setupError.status === 409) {
      showLoginForm();
      document.getElementById("loginError").textContent = setupError.message;
      document.getElementById("loginError").classList.remove("hidden");
    }
  } finally {
    button.disabled = false;
    document.getElementById("showLoginButton").disabled = false;
    document.getElementById("showRegisterButton").disabled = false;
  }
});
document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await apiRequest("/api/auth/logout", { method: "POST", body: {} });
    showLogin();
  } catch (error) {
    showToast(error.message, true);
  }
});
function closePasswordModal() {
  const modal = document.getElementById("passwordModal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.getElementById("passwordForm").reset();
  document.getElementById("passwordError").classList.add("hidden");
}
document.getElementById("changePasswordBtn").addEventListener("click", () => {
  const modal = document.getElementById("passwordModal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("currentPassword").focus();
});
document.getElementById("closePasswordModalBtn").addEventListener("click", closePasswordModal);
document.querySelectorAll("[data-close-password]").forEach((element) => element.addEventListener("click", closePasswordModal));
document.getElementById("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = document.getElementById("passwordError");
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  if (newPassword !== document.getElementById("confirmPassword").value) {
    errorElement.textContent = "Les nouveaux mots de passe ne correspondent pas.";
    errorElement.classList.remove("hidden");
    return;
  }
  try {
    const session = await apiRequest("/api/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
    csrfToken = session.csrfToken;
    closePasswordModal();
    await loadWorkspace();
    showToast("Mot de passe modifié. Les autres sessions ont été déconnectées.");
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.classList.remove("hidden");
  }
});
document.getElementById("userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await apiRequest("/api/users", {
      method: "POST",
      body: {
        name: document.getElementById("newUserName").value.trim(),
        email: document.getElementById("newUserEmail").value.trim(),
        password: document.getElementById("newUserPassword").value,
        role: document.getElementById("newUserRole").value,
      },
    });
    document.getElementById("userForm").reset();
    await loadWorkspace();
    showToast("Compte utilisateur créé.");
  } catch (error) {
    showToast(error.message, true);
  }
});
document.getElementById("usersTable").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-user-role]");
  if (!select) return;
  try {
    await mutateAndRefresh(`/api/users/${select.dataset.userRole}`, "PATCH", { role: select.value });
    showToast("Rôle du compte mis à jour.");
  } catch (error) {
    showToast(error.message, true);
    renderUsers();
  }
});
document.getElementById("usersTable").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-user-active]");
  if (!button) return;
  const active = button.dataset.active === "true";
  if (!window.confirm(`${active ? "Activer" : "Désactiver"} ce compte ?`)) return;
  try {
    await mutateAndRefresh(`/api/users/${button.dataset.userActive}`, "PATCH", { active });
    showToast(active ? "Compte activé." : "Compte désactivé.");
  } catch (error) {
    showToast(error.message, true);
  }
});
document.getElementById("notificationsList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-notification-read]");
  if (!button) return;
  try {
    await mutateAndRefresh(`/api/notifications/${button.dataset.notificationRead}/read`, "POST", {});
  } catch (error) {
    showToast(error.message, true);
  }
});
document.getElementById("markAllNotificationsReadBtn").addEventListener("click", async () => {
  try {
    await mutateAndRefresh("/api/notifications/read-all", "POST", {});
  } catch (error) {
    showToast(error.message, true);
  }
});
document.getElementById("roomSearch").addEventListener("input", renderRooms);
document.getElementById("roomStatusFilter").addEventListener("change", renderRooms);
["bookingSearch", "bookingStatusFilter", "bookingPeriodFilter"].forEach((id) => {
  document.getElementById(id).addEventListener(id === "bookingSearch" ? "input" : "change", renderBookings);
});
document.getElementById("calendarRoomFilter").addEventListener("change", renderCalendar);
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  state.calendarView = button.dataset.view;
  renderCalendar();
}));
document.getElementById("calendarPrev").addEventListener("click", () => moveCalendar(-1));
document.getElementById("calendarNext").addEventListener("click", () => moveCalendar(1));
document.getElementById("calendarToday").addEventListener("click", () => {
  state.calendarDate = dateToISO(new Date());
  renderCalendar();
});
document.getElementById("recurrence").addEventListener("change", updateRecurrenceFields);
document.getElementById("roomsGrid").addEventListener("click", (event) => {
  const detailsButton = event.target.closest("[data-room-details]");
  if (detailsButton) {
    openRoomDetails(detailsButton.dataset.roomDetails);
    return;
  }
  const moveButton = event.target.closest("[data-room-image-move]");
  if (moveButton) {
    const roomId = Number(moveButton.dataset.roomImageMove);
    const room = getRoom(roomId);
    if (!room) return;
    const images = getRoomImageKeys(room);
    const nextIndex = (state.roomGalleryIndexes[roomId] || 0) + Number(moveButton.dataset.direction);
    state.roomGalleryIndexes[roomId] = (nextIndex + images.length) % images.length;
    renderRooms();
    return;
  }
  const thumbnailButton = event.target.closest("[data-room-image-room]");
  if (thumbnailButton) {
    state.roomGalleryIndexes[Number(thumbnailButton.dataset.roomImageRoom)] = Number(thumbnailButton.dataset.roomImageIndex);
    renderRooms();
    return;
  }
  const button = event.target.closest("[data-room-action]");
  if (button) handleRoomAction(button.dataset.roomAction, button.dataset.id);
});
document.getElementById("closeRoomDetailsBtn").addEventListener("click", () => {
  document.getElementById("roomDetailsDialog").close();
});
document.getElementById("roomDetailsDialog").addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  const bounds = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
});
document.getElementById("roomDetailsDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.close();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    roomDetailsImageIndex += event.key === "ArrowLeft" ? -1 : 1;
    updateRoomDetailsImage();
  }
});
document.getElementById("roomDetailsPrevious").addEventListener("click", () => {
  roomDetailsImageIndex -= 1;
  updateRoomDetailsImage();
});
document.getElementById("roomDetailsNext").addEventListener("click", () => {
  roomDetailsImageIndex += 1;
  updateRoomDetailsImage();
});
document.getElementById("roomDetailsImage").addEventListener("error", () => {
  document.getElementById("roomDetailsImageError").classList.remove("hidden");
});
document.getElementById("roomDetailsReserve").addEventListener("click", () => {
  document.getElementById("roomDetailsDialog").close();
  handleRoomAction("reserve", String(roomDetailsId));
});
document.getElementById("bookingTable").addEventListener("click", (event) => {
  const button = event.target.closest("[data-booking-action]");
  if (button) handleBookingAction(button.dataset.bookingAction, button.dataset.id);
});
document.getElementById("calendarGrid").addEventListener("click", (event) => {
  const bookingButton = event.target.closest("[data-calendar-booking]");
  if (bookingButton) {
    document.getElementById("bookingsSection").scrollIntoView({ behavior: "smooth" });
    document.getElementById("bookingSearch").value = state.reservations.find((booking) => booking.id === Number(bookingButton.dataset.calendarBooking))?.title || "";
    renderBookings();
    return;
  }
  const dateButton = event.target.closest("[data-calendar-date]");
  if (dateButton) {
    state.calendarDate = dateButton.dataset.calendarDate;
    dateInput.value = state.calendarDate;
    renderCalendar();
  }
});
function updateActiveNavigation() {
  const currentTarget = window.location.hash || "#homeSection";
  document.querySelectorAll(".main-nav a").forEach((link) => {
    const isActive = link.getAttribute("href") === currentTarget;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}
window.addEventListener("hashchange", updateActiveNavigation);
updateActiveNavigation();
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRoomModal();
  if (event.key === "Escape") closePasswordModal();
});

dateInput.min = dateToISO(new Date());
establishSession();
