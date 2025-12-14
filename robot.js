
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
  // SI NO VES ESTO EN EL LOG, ES QUE NO SE HA ACTUALIZADO
  console.log('🤖 [V3.3] Arrancando robot (Modo Lento + ENTER)...');
  
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
        console.log("📝 Escribiendo usuario letra a letra (evitando filtro de seguridad)...");
        // Escribimos con retardo de 200ms entre letras (muy lento)
        await page.type(selectorUsuario, process.env.HOMESERVE_USER || '', { delay: 200 }); 
        
        console.log("📝 Escribiendo contraseña...");
        await page.type(selectorPass, process.env.HOMESERVE_PASS || '', { delay: 200 });
        
        console.log('👆 Pulsando tecla ENTER (sin usar ratón)...');
        await page.keyboard.press('Enter');

        // Esperamos 10 segundos a ver si carga
        await page.waitForTimeout(10000);
    } else {
        console.log("⚠️ No veo la casilla de login.");
    }

    // --- PASO 2: DIAGNÓSTICO DE ERROR ---
    const currentUrl = page.url();
    if (currentUrl.includes('PROF_PASS')) {
        console.error("⛔ SEGUIMOS EN EL LOGIN. DIAGNÓSTICO:");
        
        // Vamos a leer qué error sale en la pantalla
        const textoPantalla = await page.evaluate(() => document.body.innerText);
        
        if (textoPantalla.includes("Usuario incorrecto") || textoPantalla.includes("Clave incorrecta")) {
            console.error("❌ LA WEB DICE: Credenciales incorrectas.");
        } else if (textoPantalla.trim() === "") {
            console.error("❌ LA WEB ESTÁ EN BLANCO.");
        } else {
            console.error("❌ MENSAJE DE LA WEB:\n" + textoPantalla.substring(0, 300));
        }
        
        // Hacemos una última prueba: ¿Se han rellenado los campos?
        const valorUsuario = await page.$eval('input[name="CODIGO"]', el => el.value);
        console.error(`👀 El robot escribió en usuario: "${valorUsuario}"`);
        
        throw new Error("No pudimos pasar del login.");
    }

    // --- PASO 3: EXTRACCIÓN ---
    console.log('📂 ¡Login ÉXITOSO! Buscando servicios...');
    
    // Forzamos la navegación a la lista por si acaso
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
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
    console.log('🏁 Fin V3.3');
    process.exit(0);
  }
}

runRobot();
