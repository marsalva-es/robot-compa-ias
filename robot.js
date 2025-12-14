const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- CONFIGURACIÓN FIREBASE ---
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

async function runRobot() {
  console.log('🤖 [V3.2] Arrancando robot HomeServe (Modo Tecleo Humano)...');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // --- PASO 1: LOGIN ---
    console.log('🔐 Entrando al login...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 60000 });

    const selectorUsuario = 'input[name="CODIGO"]';
    const selectorPass = 'input[type="password"]';

    if (await page.isVisible(selectorUsuario)) {
        console.log("📝 Escribiendo credenciales lentamente (como un humano)...");
        
        // TRUCO 1: Escribir con retardo (delay) para engañar al filtro 'FILTRA(event)'
        // Escribe el usuario
        await page.type(selectorUsuario, process.env.HOMESERVE_USER || '', { delay: 150 }); 
        
        // Escribe la contraseña
        await page.type(selectorPass, process.env.HOMESERVE_PASS || '', { delay: 150 });
        
        console.log('👆 Pulsando tecla ENTER...');
        // TRUCO 2: Pulsar Enter suele ser más seguro que buscar el botón en webs antiguas
        await page.keyboard.press('Enter');

        // Esperamos a que la página reaccione
        await page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' });
        
    } else {
        console.log("⚠️ No veo la casilla CODIGO.");
    }

    // --- PASO 2: VERIFICACIÓN ---
    // Si seguimos en la URL de login (PROF_PASS) o vemos el mensaje de error
    const currentUrl = page.url();
    if (currentUrl.includes('PROF_PASS')) {
        console.error("⛔ LOGIN FALLIDO: La web nos ha devuelto al inicio.");
        
        // Intentamos leer el mensaje de error rojo de la web
        const errorEnPantalla = await page.evaluate(() => {
            return document.body.innerText;
        });

        if (errorEnPantalla.includes("incorrecto") || errorEnPantalla.includes("inexistente")) {
            console.error("👉 LA WEB DICE: Usuario o contraseña incorrectos.");
        } else {
            console.error("👉 TEXTO EN PANTALLA (Primeras lineas):");
            console.error(errorEnPantalla.substring(0, 200));
        }
        throw new Error("No pudimos pasar del login.");
    }

    // --- PASO 3: EXTRACCIÓN ---
    console.log('📂 ¡Estamos dentro! Leyendo servicios...');
    // Aseguramos estar en la lista total
    if (!currentUrl.includes('lista_servicios_total')) {
        await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    }

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

    // --- PASO 4: GUARDADO ---
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
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 Fin V3.2');
    process.exit(0);
  }
}

runRobot();
