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
  console.log('🤖 [V6.1] Arrancando robot (Dirección Unificada + Actualización de Estado)...');
  
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
        await page.type(selectorUsuario, process.env.HOMESERVE_USER || '', { delay: 100 }); 
        await page.type(selectorPass, process.env.HOMESERVE_PASS || '', { delay: 100 });
        console.log('👆 Pulsando ENTER...');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000); 
    }

    // --- PASO 2: OBTENER LISTA DE REFERENCIAS ---
    console.log('📂 Leyendo lista de servicios...');
    await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
    
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

    console.log(`🔎 Encontrados ${referenciasEnWeb.length} servicios en la web. Revisando uno a uno...`);

    // --- PASO 3: PROCESAR CADA SERVICIO ---
    let actualizados = 0;
    let nuevos = 0;

    for (const ref of referenciasEnWeb) {
        
        // 1. Antes de entrar, miramos si existe en Firebase para comparar el estado
        const docRef = db.collection(COLLECTION_NAME).doc(ref);
        const docSnapshot = await docRef.get();
        let datosAntiguos = null;

        if (docSnapshot.exists) {
            datosAntiguos = docSnapshot.data();
        }

        // 2. Entramos SIEMPRE a la ficha para leer los datos frescos de la web
        // (Necesario para ver si el estado ha cambiado)
        await page.goto('https://www.clientes.homeserve.es/cgi-bin/fccgi.exe?w3exec=lista_servicios_total');
        
        try {
            // Buscamos el click por el número de referencia
            await page.click(`text="${ref}"`);
            await page.waitForTimeout(1500); 
        } catch (e) {
            console.error(`⚠️ No pude entrar en la ficha ${ref}. Saltando.`);
            continue;
        }

        // 3. LEEMOS LOS DATOS (SCRAPING)
        const detalles = await page.evaluate(() => {
            const d = {};
            const filas = Array.from(document.querySelectorAll('tr'));
            filas.forEach(tr => {
                const celdas = tr.querySelectorAll('td');
                if (celdas.length >= 2) {
                    const clave = celdas[0].innerText.toUpperCase().trim();
                    const valor = celdas[1].innerText.trim();

                    if (clave.includes("TELEFONOS")) d.phone = valor;
                    if (clave.includes("CLIENTE")) d.clientName = valor;
                    if (clave.includes("DOMICILIO")) d.addressPart = valor; // Parte 1 dirección
                    if (clave.includes("POBLACION")) d.cityPart = valor;    // Parte 2 dirección
                    if (clave.includes("ACTUALMENTE EN")) d.status_homeserve = valor;
                    if (clave.includes("COMPAÑIA")) d.company = valor;
                    if (clave.includes("FECHA ASIGNACION")) d.dateString = valor;
                    if (clave.includes("COMENTARIOS")) d.description = valor;
                }
            });
            return d;
        });

        // 4. PREPARAMOS LOS DATOS (Lógica nueva)
        
        // A) Juntar Domicilio + Población en 'address'
        const fullAddress = `${detalles.addressPart || ""} ${detalles.cityPart || ""}`.trim();

        // B) Añadir prefijo HOMESERVE a la compañía
        let rawCompany = detalles.company || "";
        // Evitamos poner "HOMESERVE - HOMESERVE..." si ya lo tiene
        if (!rawCompany.toUpperCase().includes("HOMESERVE")) {
            rawCompany = `HOMESERVE - ${rawCompany}`;
        }
        const finalCompany = rawCompany;

        const servicioFinal = {
            serviceNumber: ref,
            clientName: detalles.clientName || "Desconocido",
            address: fullAddress, // Campo unificado
            phone: detalles.phone || "Sin teléfono",
            description: detalles.description || "",
            homeserveStatus: detalles.status_homeserve || "",
            company: finalCompany, // Con prefijo
            dateString: detalles.dateString || "",
            
            status: "pendiente_validacion",
            updatedAt: new Date().toISOString()
        };

        // Si es nuevo, añadimos fecha de creación
        if (!datosAntiguos) {
            servicioFinal.createdAt = new Date().toISOString();
        }

        // 5. DECISIÓN: ¿GUARDAR O NO?
        
        if (!datosAntiguos) {
            // CASO 1: NO EXISTE -> CREAR
            await docRef.set(servicioFinal);
            console.log(`➕ NUEVO servicio guardado: ${ref}`);
            nuevos++;
        } else {
            // CASO 2: YA EXISTE -> COMPARAR ESTADO
            const estadoAntiguo = datosAntiguos.homeserveStatus;
            const estadoNuevo = servicioFinal.homeserveStatus;

            // También actualizamos si la dirección antigua no tenía el formato nuevo
            // (Esto arreglará los registros que guardaste hace 10 minutos mal)
            const direccionAntigua = datosAntiguos.address;

            if (estadoAntiguo !== estadoNuevo) {
                console.log(`♻️ CAMBIO DETECTADO en ${ref}: "${estadoAntiguo}" -> "${estadoNuevo}". Actualizando...`);
                await docRef.set(servicioFinal, { merge: true });
                actualizados++;
            } else if (direccionAntigua !== fullAddress) {
                console.log(`🔧 Corrigiendo formato dirección en ${ref}. Actualizando...`);
                await docRef.set(servicioFinal, { merge: true });
                actualizados++;
            } else {
                console.log(`zzz El servicio ${ref} no ha cambiado. Salto.`);
            }
        }
    }

    console.log(`🏁 FIN: ${nuevos} nuevos, ${actualizados} actualizados.`);

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

runRobot();
