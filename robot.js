const { chromium } = require('playwright');
const admin = require('firebase-admin');

// --- 1. CONFIGURACIÓN FIREBASE ---
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
async function runRobot() {
  console.log('🤖 [V3.0] Arrancando robot HomeServe (Versión Corregida)...');
  
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

    // ⚠️ AQUÍ ESTÁ LA CORRECCIÓN BASADA EN TU FOTO ⚠️
    // Tu foto dice que el usuario es 'CODIGO'.
    // Para la contraseña usamos 'type=password' que es infalible.
    const selectorUsuario = 'input[name="CODIGO"]';
    const selectorPass = 'input[type="password"]';

    if (await page.isVisible(selectorUsuario)) {
        console.log("📝 Rellenando credenciales...");
        await page.fill(selectorUsuario, process.env.HOMESERVE_USER || ''); 
        await page.fill(selectorPass, process.env.HOMESERVE_PASS || '');
        
        console.log('👆 Pulsando botón "Aceptar"...');
        await Promise.all([
          page.waitForNavigation({ timeout: 30000 }), 
          // Buscamos el botón por el texto "Aceptar" o por ser input submit
          page.click('input[type="submit"], input[value="Aceptar"]')
        ]);
    } else {
        console.log("⚠️ No veo la casilla CODIGO. ¿Quizás ya estamos dentro?");
    }

    // --- PASO 2: VERIFICAR SI ENTRAMOS ---
    // Si la URL sigue teniendo 'PROF_PASS', es que el login falló
    if (page.url().includes('PROF_PASS')) {
        console.error("⛔ LOGIN FALLIDO. Revisa que tu Usuario y Contraseña en Render sean correctos.");
        // Imprimimos el texto de error de la web si lo hay
        const errorText = await page.innerText('body'); 
        if(errorText.includes("incorrecto")) console.error("La web dice: Usuario o clave incorrectos.");
        throw new Error("No se pudo iniciar sesión.");
    }

    // --- PASO 3: IR A LA LISTA ---
    console.log('📂 Navegando a lista de servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    // --- PASO 4: LEER DATOS ---
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        // Filtramos filas que tengan datos
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim();
            // Comprobamos que sea un número de referencia válido
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

    // --- PASO 5: GUARDAR EN FIREBASE ---
    let nuevos = 0;
    for (const s of servicios) {
      const docRef = db.collection(COLLECTION_NAME).doc(s.serviceNumber);
      const doc = await docRef.get();
      if (!doc.exists) {
        await docRef.set(s);
        console.log(`➕ Guardado nuevo servicio: ${s.serviceNumber}`);
        nuevos++;
      }
    }
    
    if (nuevos === 0) console.log("💤 No hay servicios nuevos.");

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 Fin.');
    process.exit(0);
  }
}

runRobot();
