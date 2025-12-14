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

// CORS: permitir Authorization + OPTIONS
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

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
  const allow = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // si no hay lista, dejamos pasar a cualquier autenticado
  if (allow.length === 0) return next();

  const email = String(req.user?.email || "").toLowerCase();
  if (!allow.includes(email)) return res.status(403).json({ error: "No admin", email });
  next();
}

// ================== ENCRYPTION HELPERS (Provider passwords) ==================
function getKey() {
  const secret = process.env.PROVIDER_CRED_SECRET || "";
  if (secret.length < 32) throw new Error("Missing/weak PROVIDER_CRED_SECRET (min 32 chars).");
  return crypto.createHash("sha256").update(secret, "utf8").digest(); // 32 bytes
}

function encryptText(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    passEnc: enc.toString("base64"),
    passIv: iv.toString("base64"),
    passTag: tag.toString("base64"),
  };
}

// ================== PROVIDER MAP ==================
const PROVIDERS = {
  homeserve: { pendingCollection: "homeserve_pendientes", label: "HomeServe" },
  multiasistencia: { pendingCollection: "multiasistencia_pendientes", label: "Multiasistencia" },
  todo: { pendingCollection: "todo_pendientes", label: "To&Do" },
};

function getProviderOrThrow(provider) {
  const key = String(provider || "").toLowerCase();
  const p = PROVIDERS[key];
  if (!p) throw new Error("Provider not supported");
  return { key, ...p };
}

// ================== PROVIDER CONFIG (Firestore) ==================
const PROVIDER_CONFIG_COLLECTION = "providerConfigs";

// ------- RUTAS "NUEVAS" -------
app.get("/admin/provider/:provider", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key: provider } = getProviderOrThrow(req.params.provider);
    const snap = await db.collection(PROVIDER_CONFIG_COLLECTION).doc(provider).get();
    if (!snap.exists) return res.json({ user: "", hasPass: false, lastChange: null });

    const d = snap.data() || {};
    return res.json({
      user: d.user || "",
      hasPass: !!(d.passEnc && d.passIv && d.passTag),
      lastChange: d.updatedAt?.toDate?.() ? d.updatedAt.toDate().toISOString() : null,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

app.post("/admin/provider/:provider", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key: provider } = getProviderOrThrow(req.params.provider);

    const user = String(req.body.user || "").trim();
    const pass = req.body.pass; // string o "********" o ""

    if (!user) return res.status(400).json({ error: "Missing user" });

    const payload = {
      user,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // si pass viene como "********" => no tocar
    if (typeof pass === "string" && pass.trim() && pass.trim() !== "********") {
      Object.assign(payload, encryptText(pass.trim()));
    }

    await db.collection(PROVIDER_CONFIG_COLLECTION).doc(provider).set(payload, { merge: true });
    return res.json({ success: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

// ------- ALIAS "COMPATIBILIDAD" para TU HTML ( /admin/config/... ) -------
app.get("/admin/config/:provider", requireAuth, requireAdmin, async (req, res) => {
  // Reusa la lógica de /admin/provider/:provider
  req.params.provider = req.params.provider;
  return app._router.handle(req, res, () => {}, "get", "/admin/provider/:provider");
});

app.post("/admin/config/:provider", requireAuth, requireAdmin, async (req, res) => {
  // Reusa la lógica de /admin/provider/:provider
  req.params.provider = req.params.provider;
  return app._router.handle(req, res, () => {}, "post", "/admin/provider/:provider");
});

// ================== SERVICES (Pendientes) ==================
app.get("/admin/services/:provider", requireAuth, requireAdmin, async (req, res) => {
  try {
    const p = getProviderOrThrow(req.params.provider);

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
        homeserveStatus: d.homeserveStatus || d.providerStatus || "",
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

app.post("/admin/services/:provider/delete", requireAuth, requireAdmin, async (req, res) => {
  try {
    const p = getProviderOrThrow(req.params.provider);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: "ids[] required" });

    const batch = db.batch();
    ids.forEach(id => batch.delete(db.collection(p.pendingCollection).doc(id)));
    await batch.commit();

    return res.json({ success: true, deleted: ids.length });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Error" });
  }
});

app.post("/admin/services/:provider/to-appointments", requireAuth, requireAdmin, async (req, res) => {
  try {
    const p = getProviderOrThrow(req.params.provider);

    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: "ids[] required" });

    const appointmentsCol = "appointments";
    let moved = 0;

    for (const id of ids) {
      const pendingRef = db.collection(p.pendingCollection).doc(id);
      const snap = await pendingRef.get();
      if (!snap.exists) continue;

      const d = snap.data() || {};
      const serviceNumber = String(d.serviceNumber || id);
      const appointmentDocId = serviceNumber;

      const appointment = {
        id: appointmentDocId,
        title: (d.description && String(d.description).trim()) ? String(d.description).trim() : "Servicio",
        clientName: d.clientName || "",
        address: d.address || "",
        phone: d.phone || "",
        isInsurance: true,
        insuranceCompany: d.company || "",
        serviceNumber: serviceNumber,
        notes: "",
        clientNotes: "",
        duration: 60,
        status: "pendingStart",
        isUrgent: false,
        date: admin.firestore.Timestamp.fromDate(new Date()),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        sourceProvider: p.key,
        sourcePendingDocId: id,
      };

      await db.collection(appointmentsCol).doc(appointmentDocId).set(appointment, { merge: true });

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

// ================== ALWAYS JSON FOR UNKNOWN ROUTES ==================
app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));

// ================== PORT ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server running on port", PORT));
