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

// ⚠️ CAMBIO 1: NUEVA COLECCIÓN (Bandeja de entrada)
// Aquí caerán los datos en bruto para que tú los valides desde la App
const COLLECTION_NAME = "homeserve_pendientes";

async function runRobot() {
  console.log('🤖 [V5.0] Arrancando robot (Ajuste de Columnas y Colección)...');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // --- PASO 1: LOGIN (Igual que antes, funciona bien) ---
    console.log('🔐 Entrando al login...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=PROF_PASS', { timeout: 60000 });

    const selectorUsuario = 'input[name="CODIGO"]';
    const selectorPass = 'input[type="password"]';

    if (await page.isVisible(selectorUsuario)) {
        await page.type(selectorUsuario, process.env.HOMESERVE_USER || '', { delay: 100 }); 
        await page.type(selectorPass, process.env.HOMESERVE_PASS || '', { delay: 100 });
        console.log('👆 Pulsando ENTER...');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000); 
    }

    // --- PASO 2: IR A LA LISTA ---
    console.log('📂 Yendo a la Lista de Servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    // --- PASO 3: LEER DATOS (CON CORRECCIÓN DE COLUMNAS) ---
    const servicios = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const datos = [];
      
      filas.forEach((tr, index) => {
        const tds = tr.querySelectorAll('td');
        
        // Solo miramos filas con datos (más de 5 columnas)
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim(); 
            
            // Validamos que sea un número de servicio real
            if (ref && !isNaN(ref.replace(/\D/g,'')) && ref.length > 3) { 
                
                // ⚠️ MAPEO CORREGIDO SEGÚN TUS INDICACIONES ⚠️
                // Col 0: Referencia (OK)
                // Col 1: Cliente (Probamos aquí, antes estaba mal)
                // Col 2: Dirección (Tú dijiste que aquí salía la dirección)
                // Col 3: Descripción/Estado (Donde salía "En espera...")
                // Col 4: Fecha (Donde salía "14/08/2025")
                // Col 5: Teléfono (Probablemente esté aquí)

                datos.push({
                    serviceNumber: ref,
                    clientName: tds[1]?.innerText?.trim() || "Desconocido", // Columna 1
                    address: tds[2]?.innerText?.trim() || "Sin dirección",  // Columna 2
                    description: tds[3]?.innerText?.trim(),                 // Columna 3 (Extra)
                    dateString: tds[4]?.innerText?.trim(),                  // Columna 4 (Fecha original)
                    phone: tds[5]?.innerText?.trim() || "Sin teléfono",     // Columna 5
                    
                    // Campos fijos para tu App
                    status: "pendiente_validacion", // Estado nuevo para tu Inbox
                    insuranceCompany: "HOMESERVE",
                    createdAt: new Date().toISOString(),
                    
                    // GUARDAMOS LA FILA ENTERA EN TEXTO PARA DEPURAR (Por si fallamos otra vez)
                    _debug_raw: tr.innerText 
                });
            }
        }
      });
      return datos;
    });

    console.log(`📦 Encontrados: ${servicios.length} servicios.`);

    // Imprimimos el primero para que compruebes en el Log si está bien
    if (servicios.length > 0) {
        console.log("🔎 EJEMPLO DEL PRIMER SERVICIO CAPTURADO:");
        console.log(JSON.stringify(servicios[0], null, 2));
    }

    // --- PASO 4: GUARDAR EN LA NUEVA COLECCIÓN ---
    let guardados = 0;
    for (const s of servicios) {
      // Usamos la nueva colección "homeserve_pendientes"
      const docRef = db.collection(COLLECTION_NAME).doc(s.serviceNumber);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        await docRef.set(s);
        console.log(`➕ Guardado en ${COLLECTION_NAME}: ${s.serviceNumber}`);
        guardados++;
      }
    }
    
    if (servicios.length > 0 && guardados === 0) {
        console.log("✅ No hay servicios NUEVOS (ya existían en la colección).");
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 Fin V5.0');
    process.exit(0);
  }
}

runRobot();
