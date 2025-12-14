const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- CONFIGURACIÓN DE FIREBASE ---
if (process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
    });
  } catch (err) {
    console.error("❌ Error inicializando Firebase:", err.message);
    process.exit(1);
  }
} else {
  console.error("⚠️ FALTAN LAS CLAVES DE FIREBASE");
  process.exit(1);
}

const db = admin.firestore();
const COLLECTION_NAME = "appointments";

// --- FUNCIÓN PRINCIPAL ---
async function iniciarRobot() {
  console.log('🤖 [V2.0] Arrancando robot HomeServe...');
  
  // En Docker, Playwright necesita estos argumentos para no fallar
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  }); 
  
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. LOGIN
    console.log('🔐 Entrando al login...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 60000 });

    const userSelector = 'input[name="Usuario"]';
    const passSelector = 'input[name="Password"]';
    
    // Verificamos si existen los campos
    if (await page.isVisible(userSelector)) {
        await page.fill(userSelector, process.env.HOMESERVE_USER || ''); 
        await page.fill(passSelector, process.env.HOMESERVE_PASS || '');
        
        console.log('👆 Pulsando botón de entrar...');
        await Promise.all([
          page.waitForNavigation({ timeout: 30000 }), 
          page.click('input[type="submit"], button[type="submit"]')
        ]);
    } else {
        console.log("⚠️ No veo el formulario de login. ¿Quizás ya estamos dentro?");
    }

    // 2. IR A LA LISTA
    console.log('📂 Yendo a lista de servicios...');
    const response = await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    if (!response.ok()) throw new Error("La web de HomeServe no carga.");

    // 3. LEER DATOS
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim();
            if (ref && !isNaN(ref) && ref.length > 3) { 
                datos.push({
                    serviceNumber: ref,
                    clientName: tds[2]?.innerText?.trim(),
                    address: tds[3]?.innerText?.trim(),
                    phone: tds[4]?.innerText?.trim(),
                    status: "pendingStart",
                    createdAt: new Date().toISOString()
                });
            }
        }
      });
      return datos;
    });

    console.log(`📦 Encontrados: ${servicios.length} servicios.`);

    // 4. GUARDAR
    for (const s of servicios) {
      const docRef = db.collection(COLLECTION_NAME).doc(s.serviceNumber);
      const doc = await docRef.get();
      if (!doc.exists) {
        await docRef.set(s);
        console.log(`➕ Guardado: ${s.serviceNumber}`);
      }
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
  } finally {
    await browser.close();
    console.log('🏁 Fin.');
    process.exit(0);
  }
}

// ⚠️ LLAMADA A LA FUNCIÓN NUEVA
iniciarRobot();
