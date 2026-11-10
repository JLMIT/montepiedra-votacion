// Datos iniciales: solo CREA documentos que no existen (nunca sobrescribe datos vivos).
// Se ejecuta en cada publicación (GitHub Actions) con la cuenta de servicio.
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "seed");
initializeApp({ credential: applicationDefault(), projectId: "montepiedra-f6ce2" });
const db = getFirestore();
let created = 0, skipped = 0;
async function create(path, data) {
  try { await db.doc(path).create(data); created++; }
  catch (e) { if (e.code === 6 /* ALREADY_EXISTS */) skipped++; else throw e; }
}
const admins = JSON.parse(readFileSync(join(root, "admins.json"), "utf8")).map(e => String(e).trim().toLowerCase()).filter(Boolean);
for (const em of admins) await create(`admins/${em}`, { email: em, addedBy: "carga inicial", at: FieldValue.serverTimestamp() });
await create("config/main", { name: "Asamblea de copropietarios", date: "" });
await create("config/habiles", { inhabiles: {} });
console.log(`Datos iniciales: ${created} creados, ${skipped} ya existían. Administradores iniciales: ${admins.join(", ")}`);
