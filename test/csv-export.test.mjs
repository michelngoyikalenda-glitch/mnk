import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");
const exportCode = script.slice(
  script.indexOf("function csvCell("),
  script.indexOf('document.getElementById("reservationForm").addEventListener'),
);

test("CSV export rejects non-administrators before reading reservations or creating a download", () => {
  for (const role of ["Utilisateur", "Gestionnaire", ""]) {
    const messages = [];
    const context = vm.createContext({
      state: { role },
      showToast: (message, isError) => messages.push({ message, isError }),
      getSortedReservations: () => assert.fail("Unauthorized export read reservations"),
      URL: { createObjectURL: () => assert.fail("Unauthorized download") },
    });
    vm.runInContext(`${exportCode}\nexportReservations();`, context);
    assert.deepEqual(messages, [{
      message: "L’export CSV est réservé aux administrateurs.",
      isError: true,
    }]);
  }
});

test("administrators retain CSV downloads with the expected columns and escaped values", async () => {
  let downloadedBlob;
  let clicked = false;
  let revokedUrl;
  const link = { click: () => { clicked = true; } };
  const messages = [];
  const context = vm.createContext({
    state: { role: "Administrateur" },
    Blob,
    URL: {
      createObjectURL: (blob) => { downloadedBlob = blob; return "blob:csv-test"; },
      revokeObjectURL: (url) => { revokedUrl = url; },
    },
    document: { createElement: () => link },
    dateToISO: () => "2026-10-24",
    getRoom: () => ({ name: 'Salle "A"', code: "A" }),
    getSortedReservations: () => [{
      roomId: 1, date: "2026-10-24", start: "08:00", end: "10:00",
      title: "=1+1", eventType: "Formation", owner: "Client", guests: 5,
      status: "en attente", comment: "Avec projecteur",
    }],
    showToast: (message) => messages.push(message),
  });
  vm.runInContext(`${exportCode}\nexportReservations();`, context);
  assert.equal(clicked, true);
  assert.equal(link.download, "roomflow-reservations-2026-10-24.csv");
  assert.equal(link.href, "blob:csv-test");
  assert.equal(revokedUrl, link.href);
  assert.equal(downloadedBlob.type, "text/csv;charset=utf-8");
  assert.equal(await downloadedBlob.text(), [
    '"Salle";"Code";"Date";"Début";"Fin";"Objet";"Type d’événement";"Demandeur";"Participants";"Statut";"Commentaire"',
    '"Salle ""A""";"A";"2026-10-24";"08:00";"10:00";"\'=1+1";"Formation";"Client";"5";"en attente";"Avec projecteur"',
  ].join("\r\n"));
  assert.deepEqual(messages, ["Export CSV téléchargé."]);
});

test("the CSV button belongs only to the administrator reports section", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal((html.match(/id="exportCsvBtn"/g) || []).length, 1);
  const reports = html.match(/<section[^>]*id="reportsSection"[\s\S]*?<\/section>/)?.[0];
  assert.ok(reports);
  assert.match(reports, /class="panel section-panel admin-only hidden"/);
  assert.match(reports, /class="secondary-btn admin-only hidden" id="exportCsvBtn"/);
});
