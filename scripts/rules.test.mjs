// Pruebas de las reglas de seguridad contra el emulador de Firestore (corren en GitHub antes de publicar).
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const env = await initializeTestEnvironment({ projectId: "demo-montepiedra", firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") } });
const clave = (k, c) => createHash("sha256").update(k + "|" + c.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
await env.withSecurityRulesDisabled(async ctx => {
  const d = ctx.firestore();
  await setDoc(doc(d, "admins/jvalenzuela@ebisa.cl"), { email: "jvalenzuela@ebisa.cl" });
  await setDoc(doc(d, "config/habiles"), { inhabiles: { "REHUE-10": true } });
  for (const [k, c] of [["MONTEPIEDRA-52", "AAAA-1111"], ["UYUNI-16", "BBBB-2222"], ["REHUE-10", "CCCC-3333"], ["RALI-10", "DDDD-4444"]]) await setDoc(doc(d, "claves", clave(k, c)), { unit: k });
  await setDoc(doc(d, "items/t1"), { title: "Presupuesto", status: "open", options: ["Sí", "No", "Abstención"] });
  await setDoc(doc(d, "items/t2"), { title: "Cerrado", status: "closed", options: ["Sí", "No"] });
});
const ana = env.authenticatedContext("ana").firestore();          // votante anónimo
const beto = env.authenticatedContext("beto").firestore();        // otro votante
const adm = env.authenticatedContext("admin1", { email: "jvalenzuela@ebisa.cl", email_verified: true }).firestore();
const intruso = env.authenticatedContext("x", { email: "otro@gmail.com", email_verified: true }).firestore();
const anon = env.unauthenticatedContext().firestore();
const reg = (db, k, c, uid, via = "app", name = "") => setDoc(doc(db, "reg", k), { unit: k, uid, clave: clave(k, c), name, at: serverTimestamp(), via });
const vote = (db, item, k, option, uid, channel = "app", name = "") => setDoc(doc(db, "votos", `${item}__${k}`), { item, unit: k, option, uid, channel, name, at: serverTimestamp() });

let n = 0, bad = 0;
async function t(name, p) { n++; try { await p; console.log("✓", name); } catch (e) { bad++; console.log("✗", name, "-", e.message); } }

await t("sin sesión no lee nada", assertFails(getDoc(doc(anon, "items/t1"))));
await t("votante lee una clave conociendo propiedad y código", assertSucceeds(getDoc(doc(ana, "claves", clave("MONTEPIEDRA-52", "AAAA-1111")))));
await t("votante no puede listar las claves", assertFails(getDocs(collection(ana, "claves"))));
await t("votante no lee los códigos en claro", assertFails(getDoc(doc(ana, "secretos/codigos"))));
await t("código de otra propiedad no sirve", assertFails(reg(ana, "MONTEPIEDRA-52", "BBBB-2222", "ana")));
await t("código inventado no sirve", assertFails(reg(ana, "MONTEPIEDRA-52", "ZZZZ-9999", "ana")));
await t("inscribir con su código", assertSucceeds(reg(ana, "MONTEPIEDRA-52", "AAAA-1111", "ana", "app", "Ana")));
await t("el mismo código no se puede usar dos veces", assertFails(reg(beto, "MONTEPIEDRA-52", "AAAA-1111", "beto")));
await t("ni el mismo votante puede reescribir su inscripción", assertFails(reg(ana, "MONTEPIEDRA-52", "AAAA-1111", "ana")));
await t("no se puede inscribir a nombre de otro", assertFails(reg(beto, "UYUNI-16", "BBBB-2222", "ana")));
await t("votante no puede inscribirse como mesa", assertFails(reg(beto, "UYUNI-16", "BBBB-2222", "mesa", "mesa")));
await t("propiedad inhabilitada no se inscribe", assertFails(reg(beto, "REHUE-10", "CCCC-3333", "beto")));
await t("poder: segunda propiedad para la misma persona", assertSucceeds(reg(ana, "UYUNI-16", "BBBB-2222", "ana", "app", "Ana")));
await t("votante lee sus inscripciones", assertSucceeds(getDocs(query(collection(ana, "reg"), where("uid", "==", "ana")))));
await t("votante no lee inscripciones ajenas", assertFails(getDocs(collection(beto, "reg"))));
await t("votante no lee la inscripción ajena", assertFails(getDoc(doc(beto, "reg/MONTEPIEDRA-52"))));
await t("votar por su propiedad", assertSucceeds(vote(ana, "t1", "MONTEPIEDRA-52", "Sí", "ana", "app", "Ana")));
await t("no se puede votar dos veces", assertFails(vote(ana, "t1", "MONTEPIEDRA-52", "No", "ana", "app", "Ana")));
await t("no se puede votar por propiedad ajena", assertFails(vote(beto, "t1", "UYUNI-16", "No", "beto", "app", "Ana")));
await t("no se puede votar en tema cerrado", assertFails(vote(ana, "t2", "UYUNI-16", "Sí", "ana", "app", "Ana")));
await t("opción inexistente rechazada", assertFails(vote(ana, "t1", "UYUNI-16", "Tal vez", "ana", "app", "Ana")));
await t("votar por la segunda propiedad (poder)", assertSucceeds(vote(ana, "t1", "UYUNI-16", "Sí", "ana", "app", "Ana")));
await t("votante lee solo sus votos", assertSucceeds(getDocs(query(collection(ana, "votos"), where("uid", "==", "ana")))));
await t("votante no ve votos ajenos antes del cierre", assertFails(getDocs(collection(beto, "votos"))));
await t("votante no puede borrar votos", assertFails(deleteDoc(doc(ana, "votos/t1__MONTEPIEDRA-52"))));
await t("votante no modifica temas", assertFails(setDoc(doc(ana, "items/t1"), { title: "x", status: "open", options: ["Sí"] })));
await t("votante no se agrega como administrador", assertFails(setDoc(doc(ana, "admins/ana@x.cl"), { email: "ana@x.cl" })));
await t("cuenta Google no registrada no administra", assertFails(getDocs(collection(intruso, "votos"))));
await t("administración lee todos los votos", assertSucceeds(getDocs(collection(adm, "votos"))));
await t("mesa inscribe con código", assertSucceeds(reg(adm, "RALI-10", "DDDD-4444", "mesa", "mesa")));
await t("mesa vota por propiedad inscrita en la mesa", assertSucceeds(vote(adm, "t1", "RALI-10", "No", "mesa", "mesa")));
await t("mesa no vota por propiedad de un teléfono", assertFails(setDoc(doc(adm, "votos/t2__MONTEPIEDRA-52"), { item: "t2", unit: "MONTEPIEDRA-52", option: "Sí", uid: "mesa", channel: "mesa", name: "", at: serverTimestamp() })));
await t("administración publica temas y estadísticas", assertSucceeds(setDoc(doc(adm, "stats/asistencia"), { n: 3, share: 0.02 })));
await t("administración libera una inscripción", assertSucceeds(deleteDoc(doc(adm, "reg/UYUNI-16"))));

await env.cleanup();
console.log(`${n - bad} de ${n} pruebas de reglas pasaron.`);
if (bad) process.exit(1);
