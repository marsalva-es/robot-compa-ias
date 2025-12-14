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
const COLLECTION_NAME = "homeserve_pendientes";

async function runRobot() {
  console.log('🤖 [V6.0] Arrancando robot (Modo FICHA DETALLADA)...');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  }); 
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // --- PASO 1: LOGIN (Mismo método que sabemos que funciona) ---
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

    // --- PASO 2: OBTENER LISTA DE IDs NUEVOS ---
    console.log('📂 Leyendo lista para detectar nuevos servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
    // Solo sacamos los NUMEROS de referencia primero
    const referenciasEnWeb = await page.evaluate(() => {
      const filas = Array.from(document.querySelectorAll('table tr'));
      const refs = [];
      filas.forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length > 5) {
            let ref = tds[0]?.innerText?.trim();
            if (ref && !isNaN(ref.replace(/\D/g,'')) && ref.length > 3) {
                refs.push(ref);
            }
        }
      });
      return refs;
    });

    console.log(`🔎 Detectados ${referenciasEnWeb.length} servicios en la lista.`);

    // --- PASO 3: PROCESAR UNO A UNO (Entrando en el detalle) ---
    let guardados = 0;

    for (const ref of referenciasEnWeb) {
        // 1. Chequeo rápido: ¿Ya lo tenemos en Firebase?
        const docRef = db.collection(COLLECTION_NAME).doc(ref);
        const doc = await docRef.get();

        if (doc.exists) {
            console.log(`⏩ El servicio ${ref} ya existe. Saltando...`);
            continue;
        }

        console.log(`🆕 ¡NUEVO SERVICIO ${ref}! Entrando a ver detalles...`);

        // 2. Si es nuevo, navegamos a la lista de nuevo para tener el link fresco
        // (Esto es más seguro en webs viejas que navegar directo por URL)
        await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
        
        // 3. Buscamos el enlace con ese número y hacemos clic
        // Playwright buscará un enlace o texto que coincida con la referencia
        try {
            await page.click(`text="${ref}"`);
            await page.waitForTimeout(2000); // Esperamos a que cargue la ficha amarilla
        } catch (e) {
            console.error(`⚠️ No pude hacer clic en ${ref}. Lo intento en la próxima vuelta.`);
            continue;
        }

        // 4. SCRAPING DE LA FICHA AMARILLA (Tu captura de pantalla)
        const detalles = await page.evaluate(() => {
            const datos = {};
            // Buscamos todas las filas de la tabla de detalle
            const filas = Array.from(document.querySelectorAll('tr'));
            
            filas.forEach(tr => {
                const celdas = tr.querySelectorAll('td');
                if (celdas.length >= 2) {
                    // La celda izquierda es la CLAVE (ej: "TELEFONOS:")
                    // La celda derecha es el VALOR (ej: "606033322...")
                    const clave = celdas[0].innerText.toUpperCase().trim();
                    const valor = celdas[1].innerText.trim();

                    if (clave.includes("TELEFONOS")) datos.phone = valor;
                    if (clave.includes("CLIENTE")) datos.clientName = valor;
                    if (clave.includes("DOMICILIO")) datos.address = valor;
                    if (clave.includes("POBLACION")) datos.city = valor;
                    if (clave.includes("ACTUALMENTE EN")) datos.status_homeserve = valor;
                    if (clave.includes("COMPAÑIA")) datos.company = valor;
                    if (clave.includes("FECHA ASIGNACION")) datos.dateString = valor;
                    if (clave.includes("COMENTARIOS")) datos.description = valor;
                }
            });
            return datos;
        });

        // 5. Completamos el objeto para Firebase
        const servicioFinal = {
            serviceNumber: ref,
            clientName: detalles.clientName || "Desconocido",
            address: detalles.address || "Sin dirección",
            city: detalles.city || "",
            phone: detalles.phone || "Sin teléfono",
            description: detalles.description || "",
            homeserveStatus: detalles.status_homeserve || "",
            company: detalles.company || "HOMESERVE",
            dateString: detalles.dateString || "", // Guardamos la fecha original texto
            
            status: "pendiente_validacion", // Estado para tu App
            createdAt: new Date().toISOString(),
            source: "Robot V6.0 Detallado"
        };

        // 6. Guardamos
        await docRef.set(servicioFinal);
        console.log(`✅ Guardado con detalle completo: ${ref}`);
        guardados++;
    }

    if (guardados === 0) console.log("💤 Todo al día. No hay nuevos servicios.");

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🏁 Fin V6.0');
    process.exit(0);
  }
}

runRobot();
