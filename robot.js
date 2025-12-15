// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const crypto = require("crypto");

// =====================
// Firebase Admin (ENV)
// =====================
if (!admin.apps.length) {
  if (!process.env.FIREBASE_PRIVATE_KEY) {
    console.error("⚠️ FALTAN LAS CLAVES DE FIREBASE EN ENV");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// =====================
// Express
// =====================
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// =====================
// Helpers
// =====================
function providerToPendingCollection(provider) {
  // Deja preparados futuros proveedores
  switch (String(provider || "").toLowerCase()) {
    case "homeserve":
      return "homeserve_pendientes";
    case "multiasistencia":
      return "multiasistencia_pendientes";
    case "todo":
      return "todo_pendientes";
    default:
      return null;
  }
}

function isBlockedService(data) {
  if (!data) return true;

  // Si el robot lo marca explícitamente
  if (data.blocked === true) return true;

  const status = String(data.status || "").toLowerCase();
  if (status === "bloqueado" || status === "blocked" || status === "locked") return true;

  const hs = String(data.homeserveStatus || "").toLowerCase();
  // Palabras típicas de bloqueo / acceso denegado
  if (
    /bloquead|acceso\s+deneg|no\s+autoriz|sin\s+acceso|no\s+disponible|restric/i.test(hs)
  ) {
    return true;
  }

  // Heurística: si faltan datos críticos, probablemente no pudimos entrar
  const clientName = String(data.clientName || "").trim();
  const address = String(data.address || "").trim();
  const phone = String(data.phone || "").trim();

  let missing = 0;
  if (!clientName || clientName.toLowerCase() === "desconocido") missing++;
  if (!address) missing++;
  if (!phone || phone.toLowerCase().includes("sin teléfono") || phone.toLowerCase().includes("sin telefono")) missing++;

  // Si faltan 2 o más de los 3, lo consideramos NO importable
  if (missing >= 2) return true;

  return false;
}

async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "No user" });

    const snap = await db.collection("adminUsers").doc(uid).get();
    const data = snap.exists ? snap.data() : null;

    if (!data?.enabled) {
      return res.status(403).json({ error: "No tienes permisos de admin para este panel." });
    }
    next();
  } catch (e) {
    return res.status(500).json({ error: "Admin check failed" });
  }
}

// =====================
// Health
// =====================
app.get("/health", (req, res) => res.json({ ok: true }));

// =====================
// Admin: Provider credentials
// =====================
app.get("/admin/config/:provider", requireAuth, requireAdmin, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();

  try {
    const ref = db.collection("providerCredentials").doc(provider);
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};

    res.json({
      provider,
      user: data.user || "",
      hasPass: !!data.pass,
      lastChange:
        data.updatedAt?.toDate?.()?.toISOString?.() ||
        data.updatedAt ||
        data.lastChange ||
        null,
    });
  } catch (e) {
    res.status(500).json({ error: "No se pudo cargar configuración" });
  }
});

app.post("/admin/config/:provider", requireAuth, requireAdmin, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const user = String(req.body?.user || "").trim();
  const pass = req.body?.pass; // puede ser "********"

  if (!user) return res.status(400).json({ error: "Falta user" });

  try {
    const ref = db.collection("providerCredentials").doc(provider);
    const snap = await ref.get();
    const old = snap.exists ? snap.data() : {};

    let newPass = String(pass || "").trim();
    if (newPass === "********" || newPass === "") {
      newPass = String(old?.pass || "").trim();
    }

    if (!newPass) return res.status(400).json({ error: "Falta pass" });

    await ref.set(
      {
        user,
        pass: newPass,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "No se pudo guardar configuración" });
  }
});

// =====================
// Admin: Services list (pendientes)
// =====================
app.get("/admin/services/:provider", requireAuth, requireAdmin, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const col = providerToPendingCollection(provider);
  if (!col) return res.status(400).json({ error: "Proveedor inválido" });

  const includeBlocked = String(req.query.includeBlocked || "0") === "1";

  try {
    // Leemos y filtramos en servidor (simple y robusto)
    const snap = await db.collection(col).get();
    const out = [];

    snap.forEach((d) => {
      const data = d.data() || {};
      const blocked = isBlockedService(data);

      if (!includeBlocked && blocked) return;

      out.push({
        id: d.id,
        serviceNumber: data.serviceNumber || d.id,
        client: data.clientName || "Cliente",
        address: data.address || "",
        phone: data.phone || "",
        company: data.company || "",
        homeserveStatus: data.homeserveStatus || "",
        status: data.status || "",
        blocked,
      });
    });

    // Orden “nice”: por updatedAt si existe
    out.sort((a, b) => {
      const ad = Date.parse(a.updatedAt || "") || 0;
      const bd = Date.parse(b.updatedAt || "") || 0;
      return bd - ad;
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "No se pudieron cargar servicios" });
  }
});

// =====================
// Admin: Delete pending services
// =====================
app.post("/admin/services/:provider/delete", requireAuth, requireAdmin, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const col = providerToPendingCollection(provider);
  if (!col) return res.status(400).json({ error: "Proveedor inválido" });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ success: true, deleted: 0 });

  try {
    const batch = db.batch();
    ids.forEach((id) => batch.delete(db.collection(col).doc(String(id))));
    await batch.commit();
    res.json({ success: true, deleted: ids.length });
  } catch (e) {
    res.status(500).json({ error: "No se pudieron borrar" });
  }
});

// =====================
// Admin: Import to appointments (BLOCKED FILTER HERE)
// =====================
app.post("/admin/services/:provider/to-appointments", requireAuth, requireAdmin, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const col = providerToPendingCollection(provider);
  if (!col) return res.status(400).json({ error: "Proveedor inválido" });

  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ success: true, imported: 0, skipped: [], blocked: [] });

  try {
    const imported = [];
    const blocked = [];
    const skipped = [];

    for (const rawId of ids) {
      const id = String(rawId);
      const ref = db.collection(col).doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        skipped.push({ id, reason: "not_found" });
        continue;
      }

      const data = snap.data() || {};
      if (isBlockedService(data)) {
        blocked.push({ id, reason: "blocked_or_incomplete" });
        continue;
      }

      // Crear appointment
      const appointmentDocId = crypto.randomUUID();
      const now = new Date();

      const appointment = {
        id: appointmentDocId,
        title: "Servicio (Proveedor)",
        clientName: data.clientName || "",
        address: data.address || "",
        phone: data.phone || "",
        isInsurance: true,
        insuranceCompany: data.company || "",
        serviceNumber: data.serviceNumber || id,
        status: "pendingStart", // para que caiga en “Alta siniestros”
        isUrgent: false,
        notes: data.description || "",
        clientNotes: "",
        duration: 60,
        date: admin.firestore.Timestamp.fromDate(now), // si prefieres null, dímelo y lo adaptamos
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sourceProvider: provider,
        sourcePendingId: id,
      };

      await db.collection("appointments").doc(appointmentDocId).set(appointment);

      // Marcar el pendiente como importado (para que no se reimporte)
      await ref.set(
        {
          status: "importado",
          importedAt: admin.firestore.FieldValue.serverTimestamp(),
          importedAppointmentDocId: appointmentDocId,
        },
        { merge: true }
      );

      imported.push({ id, appointmentDocId });
    }

    res.json({ success: true, imported: imported.length, importedItems: imported, blocked, skipped });
  } catch (e) {
    res.status(500).json({ error: "Error importando a appointments" });
  }
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT}`));
