// server.js
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

// ================== FIREBASE ADMIN INIT (Render env) ==================
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    console.error("❌ Faltan credenciales FIREBASE_* en environment.");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();

// ================== APP ==================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ================== AUTH MIDDLEWARE ==================
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer (.+)$/i);
    if (!m) return res.status(401).json({ error: "Missing Bearer token" });

    const decoded = await admin.auth().verifyIdToken(m[1], true);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// (Opcional) restringir a admins
function requireAdmin(req, res, next) {
  // Si no pones ADMIN_EMAILS, deja pasar a cualquier usuario autenticado.
  const allow = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) return next();

  const email = (req.user && req.user.email) ? String(req.user.email).toLowerCase() : "";
  const ok = allow.map(e => e.toLowerCase()).includes(email);
  if (!ok) return res.status(403).json({ error: "No admin" });
  next();
}

// ================== ENCRYPTION HELPERS (Provider passwords) ==================
/**
 * Set in Render:
 * PROVIDER_CRED_SECRET = 32+ chars random (best: 64 hex)
 */
function getKey() {
  const secret = process.env.PROVIDER_CRED_SECRET || "";
  if (secret.length < 32) {
    throw new Error("Missing/weak PROVIDER_CRED_SECRET (min 32 chars).");
  }
  // Derive 32-byte key from secret
  return crypto.createHash("sha256").update(secret, "utf8").digest(); // 32 bytes
}

function encryptText(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM 12 bytes
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    passEnc: enc.toString("base64"),
    passIv: iv.toString("base64"),
    passTag: tag.toString("base64"),
  };
}

function decryptText({ passEnc, passIv, passTag }) {
  const key = getKey();
  if (!passEnc || !passIv || !passTag) return null;

  const iv = Buffer.from(passIv, "base64");
  const tag = Buffer.from(passTag, "base64");
  const data = Buffer.from(passEnc, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// ================== PROVIDER MAP ==================
const PROVIDERS = {
  homeserve: {
    pendingCollection: "homeserve_pendientes",
    label: "HomeServe",
  },
  multiasistencia: {
    pendingCollection: "multiasistencia_pendientes", // preparado
    label: "Multiasistencia",
  },
  todo: {
    pendingCollection: "todo_pendientes", // preparado
    label: "To&Do",
  },
};

function getProviderOrThrow(provider) {
  const p = PROVIDERS[String(provider || "").toLowerCase()];
  if (!p) throw new Error("Provider not supported");
  return p;
}

// ================== PROVIDER CONFIG (Firestore) ==================
/**
 * Firestore:
 * collection: providerConfigs
 * doc id: homeserve | multiasistencia | todo
 *
 * fields:
 * - user: string
 * - passEnc/passIv/passTag: string (encrypted)
 * - updatedAt: serverTimestamp
 */
const PROVIDER_CONFIG_COLLECTION = "providerConfigs";

// GET provider config (no devuelve pass)
app.get("/admin/provider/:provider", requireAuth, requireAdmin, async (req, res) => {
  try {
    const provider = String(req.params.provider).toLowerCase();
    getProviderOrThrow(provider);

    const snap = await db.collection(PROVIDER_CONFIG_COLLECTION).doc(provider).get();
    if (!snap.exists) return res.json({ user: "", hasPass: false });

    const d = snap.data() || {};
    return res.json({
      user: d.user || "",
      hasPass: !!(d.passEnc && d.passIv && d.passTag),
      updatedAt: d.updatedAt || null,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

// POST provider config
// body: { user: string, pass: string|null }  (pass=null => no cambiar pass)
app.post("/admin/provider/:provider", requireAuth, requireAdmin, async (req, res) => {
  try {
    const provider = String(req.params.provider).toLowerCase();
    getProviderOrThrow(provider);

    const user = String(req.body.user || "").trim();
    const pass = req.body.pass; // string or null

    if (!user) return res.status(400).json({ error: "Missing user" });

    const ref = db.collection(PROVIDER_CONFIG_COLLECTION).doc(provider);

    const payload = {
      user,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (typeof pass === "string" && pass.trim()) {
      Object.assign(payload, encryptText(pass.trim()));
    }

    await ref.set(payload, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

// ================== SERVICES (Pendientes) ==================

// List pending services
app.get("/admin/services/:provider", requireAuth, requireAdmin, async (req, res) => {
  try {
    const provider = String(req.params.provider).toLowerCase();
    const p = getProviderOrThrow(provider);

    const snap = await db.collection(p.pendingCollection)
      .orderBy("updatedAt", "desc")
      .limit(300)
      .get();

    const out = snap.docs.map(doc => {
      const d = doc.data() || {};
      return {
        id: doc.id,
        client: d.clientName || "",
        address: d.address || "",
        phone: d.phone || "",
        serviceNumber: d.serviceNumber || doc.id,
        company: d.company || "",
        providerStatus: d.homeserveStatus || d.providerStatus || "",
        status: d.status || "",
        updatedAt: d.updatedAt || null,
        createdAt: d.createdAt || null,
        dateString: d.dateString || "",
        description: d.description || "",
      };
    });

    return res.json(out);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

// Delete pending services
app.post("/admin/services/:provider/delete", requireAuth, requireAdmin, async (req, res) => {
  try {
    const provider = String(req.params.provider).toLowerCase();
    const p = getProviderOrThrow(provider);

    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: "ids[] required" });

    const batch = db.batch();
    ids.forEach(id => {
      batch.delete(db.collection(p.pendingCollection).doc(id));
    });
    await batch.commit();

    return res.json({ success: true, deleted: ids.length });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

// Move to appointments
app.post("/admin/services/:provider/to-appointments", requireAuth, requireAdmin, async (req, res) => {
  try {
    const provider = String(req.params.provider).toLowerCase();
    const p = getProviderOrThrow(provider);

    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: "ids[] required" });

    const appointmentsCol = "appointments";
    let moved = 0;

    // Procesamos secuencial para controlar mejor errores
    for (const id of ids) {
      const pendingRef = db.collection(p.pendingCollection).doc(id);
      const snap = await pendingRef.get();
      if (!snap.exists) continue;

      const d = snap.data() || {};
      const serviceNumber = d.serviceNumber || id;

      // Guardamos en appointments con docId = serviceNumber (o id)
      const appointmentDocId = String(serviceNumber);

      const appointment = {
        id: appointmentDocId,
        title: d.description?.trim() ? d.description.trim() : "Servicio",
        clientName: d.clientName || "",
        address: d.address || "",
        phone: d.phone || "",
        isInsurance: true,
        insuranceCompany: d.company || "",
        serviceNumber: serviceNumber,
        notes: "",
        clientNotes: "",
        duration: 60,
        // lo mandamos a "Alta" -> normalmente pendingStart
        status: "pendingStart",
        isUrgent: false,
        // fecha: si no hay, hoy 00:00 (tú luego lo agendas en la app)
        date: admin.firestore.Timestamp.fromDate(new Date()),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        sourceProvider: provider,
        sourcePendingDocId: id,
      };

      await db.collection(appointmentsCol).doc(appointmentDocId).set(appointment, { merge: true });

      // Marcar en pendientes (o si prefieres: borrar)
      await pendingRef.set({
        status: "enviado_a_alta",
        movedAt: new Date().toISOString(),
        movedToAppointmentId: appointmentDocId,
      }, { merge: true });

      moved++;
    }

    return res.json({ success: true, moved });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

// ================== PORT ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
