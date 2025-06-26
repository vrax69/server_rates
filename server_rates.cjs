require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const jwt = require("jsonwebtoken");
const path = require('path');
const http = require('http');
const https = require('https');

if (process.env.NODE_ENV === 'development') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Importar el notifier usando ruta relativa
const { notifyRateChange } = require(path.join(__dirname, '..', 'discord_bot', 'discordNotifier.js'));

const JWT_SECRET ="Nwp"; // ⬅️ así lo extraes correctamente

// Verificación para asegurar que JWT_SECRET esté definido
if (!JWT_SECRET) {
  console.error('⚠️ ADVERTENCIA: JWT_SECRET no está definido en las variables de entorno');
  console.error('   Esto causará errores al validar tokens JWT');
  console.error('   Asegúrate de tener un archivo .env con JWT_SECRET=tu_secreto_aquí');
}

const app = express();

const allowedOrigins = [
  "https://nwfg.net",
  "https://www.nwfg.net",
  "http://localhost:3000",      // <-- Agregado para desarrollo local
  "https://localhost:3000"     // <-- Agregado por si usas https local
];

app.use(cors({
  origin: function (origin, callback) {
    console.log("CORS Origin recibido:", origin); // <-- Log para debug
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true); // <-- true para permitir el origin
    } else {
      callback(new Error("Not allowed by CORS: " + origin));
    }
  },
  credentials: true
}));
app.use(cookieParser());

// 1. Crear el pool al inicio
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10, // Puedes ajustar este valor
  queueLimit: 0,
  ssl: process.env.NODE_ENV === 'development' ? { rejectUnauthorized: false } : undefined
});

// 2. Middleware para asignar el pool (ya no una conexión individual)
app.use((req, res, next) => {
  req.db = pool;
  next();
});

// Endpoint para obtener los datos de la tabla Rates
app.get('/api/rates', (req, res) => {
  const query = `
    SELECT 
      id,
      Rate_ID, 
      SPL_Utility_Name, 
      Product_Name, 
      Rate, 
      ETF, 
      MSF, 
      Company_DBA_Name, 
      duracion_rate, 
      DATE_FORMAT(Last_Updated, '%Y-%m-%d') AS Last_Updated,  
      SPL 
    FROM Rates
  `;

  req.db.query(query, (err, results) => {
    if (err) {
      console.error('Error ejecutando la consulta:', err);
      return res.status(500).json({ error: 'Error al obtener datos' });
    }
    res.json(results);
  });
});

// Endpoint para obtener datos de la vista rates_view
app.get('/api/rates/view', (req, res) => {
  const query = `
    SELECT 
      Rate_ID, 
      Standard_Utility_Name, 
      Product_Name, 
      Rate, 
      ETF, 
      MSF, 
      duracion_rate, 
      Company_DBA_Name, 
      DATE_FORMAT(Last_Updated, '%Y-%m-%d') AS Last_Updated,  
      SPL, 
      State, 
      LDC, 
      Logo_URL, 
      Service_Type, 
      Unit_of_Measure, 
      Excel_Status,
      utility_contact
    FROM rates_view
  `;

  req.db.query(query, (err, results) => {
    if (err) {
      console.error('Error ejecutando la consulta en la vista:', err);
      return res.status(500).json({ error: 'Error al obtener datos de la vista' });
    }
    res.json(results);
  });
});

// Endpoint para aplicar actualizaciones desde el frontend
app.post('/api/rates/update', express.json(), async (req, res) => {
  let user = 'desconocido';
  console.log("🍪 Cookies recibidas:", req.cookies);
  const token = req.cookies.token;

  // También verificamos el header de autorización como alternativa
  const authHeader = req.headers.authorization || '';
  const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  
  // Usamos el token de cualquiera de las dos fuentes
  const finalToken = token || tokenFromHeader;

  if (finalToken) {
    try {
      const decoded = jwt.verify(finalToken, JWT_SECRET);
      if (decoded.id) {
        const result = await new Promise((resolve, reject) => {
          req.db.query('SELECT nombre FROM user_data.usuarios WHERE id = ?', [decoded.id], (err, results) => {
            if (err) reject(err);
            else resolve(results[0]); // 👈 usamos directamente el primer resultado
          });
        });
        
        user = result?.nombre || `ID:${decoded.id}`;
        

  user = result?.nombre || `ID:${decoded.id}`;
}      console.log("✅ Usuario autenticado:", user);
    } catch (err) {
      console.error("❌ Token inválido:", err.message);
    }
  } else {
    console.log("⚠️ No se proporcionó token de autenticación");
  }

  const { changes } = req.body;

  console.log("📥 Cambios recibidos:", JSON.stringify(changes, null, 2));
  console.log("🔍 Verificando campos utility_contact en los cambios:");
  changes.forEach((change, index) => {
    if (change.updated.utility_contact !== undefined) {
      console.log(`   [${index}] utility_contact: "${change.original.utility_contact}" → "${change.updated.utility_contact}"`);
    }
  });

  if (!Array.isArray(changes)) {
    return res.status(400).json({ message: "Formato de cambios inválido" });
  }

  const logEntries = [];
  const updates = [];

  for (const { original, updated } of changes) {
    const fields = [];

    for (const key in updated) {
      const originalValue = original[key];
      const updatedValue = updated[key];

      // Usar comparación más precisa para números decimales
      if (String(updatedValue) !== String(originalValue)) {
        const safeValue = updatedValue === "" ? null : updatedValue;
        fields.push(`${key} = ${mysql.escape(safeValue)}`);
        logEntries.push(JSON.stringify({
          timestamp: new Date().toISOString(),
          user,
          spl: original.SPL,
          utility_name: original.SPL_Utility_Name, // <-- Agregado
          rate_id: original.Rate_ID,
          field: key,
          from: original[key],
          to: updated[key]
        }));        
      }
    }

    if (fields.length > 0) {
      const idToUpdate = updated.id || original.id;
      if (!idToUpdate) continue;
      updates.push(`UPDATE Rates SET ${fields.join(', ')} WHERE id = ${mysql.escape(idToUpdate)};`);
    }
  }

  if (updates.length === 0) {
    return res.status(200).json({ message: "No hay cambios que aplicar." });
  }

  const connection = req.db;
  const logPath = `/home/vrax/node_apps/server_rates/logs/${new Date().toISOString().slice(0,10)}.log`;

  req.db.getConnection((err, connection) => {
    if (err) {
      console.error("❌ Error obteniendo conexión del pool:", err);
      return res.status(500).json({ message: "Error de conexión a la base de datos" });
    }

    connection.beginTransaction((err) => {
      if (err) {
        connection.release();
        console.error("❌ Error iniciando transacción:", err);
        return res.status(500).json({
          message: "Error iniciando transacción",
          error: err.message,
          stack: err.stack
        });
      }

      console.log("📝 SQL Final generado:");
      updates.forEach((q, i) => console.log(`  [${i + 1}] ${q}`));

      const execQuery = (q) => new Promise((resolve, reject) => {
        connection.query(q, (err, results) => {
          if (err) {
            console.error("❌ Error en la query individual:", q);
            console.error("❌ Mensaje:", err.message);
            console.error("❌ SQL:", err.sql);
            return reject(err);
          }
          console.log(`✅ Query ejecutada: ${q}`);
          console.log(`   Filas afectadas: ${results.affectedRows}`);
          resolve(results);
        });
      });

      Promise.all(updates.map(execQuery))
        .then((results) => {
          connection.commit((err) => {
            if (err) {
              console.error("❌ Error al hacer commit:", err);
              connection.rollback(() => {
                connection.release();
              });
              return res.status(500).json({
                message: "Error al confirmar cambios",
                error: err.message,
                stack: err.stack
              });
            }

            fs.appendFile(logPath, logEntries.join('\n') + '\n', (err) => {
              if (err) console.error("⚠️ Error al guardar log:", err);
            });

            // Notificación a Discord
            logEntries.forEach(logEntry => {
              try {
                const entry = JSON.parse(logEntry);
                notifyRateChange({
                  user,
                  spl: entry.spl,
                  utility_name: entry.utility_name, // <-- Nuevo
                  rate_id: entry.rate_id,
                  field: entry.field,
                  from: entry.from,
                  to: entry.to
                });
                

              } catch (error) {
                console.error("⚠️ Error al enviar notificación a Discord:", error);
              }
            });

            console.log("✅ Transacción completada exitosamente");
            connection.release();
            res.json({ 
              message: "Cambios aplicados correctamente.",
              updates: results.map(r => r.affectedRows).reduce((a, b) => a + b, 0)
            });
          });
        })
        .catch((err) => {
          console.error("❌ Error al aplicar cambios:");
          console.error("❌ Mensaje:", err.message);
          console.error("❌ SQL message:", err.sqlMessage);
          console.error("❌ Código:", err.code);
          console.error("❌ Stack:", err.stack);
          
          connection.rollback(() => {
            connection.release();
          });
          
          res.status(500).json({
            message: "Error al aplicar los cambios.",
            error: err.sqlMessage || err.message,
            code: err.code || "UNKNOWN",
            sql: err.sql || null,
            raw: JSON.stringify(err, Object.getOwnPropertyNames(err)),
            stack: err.stack
          });
        });
    });
  });
});

// Endpoint para obtener los campos de factura de una utility específica
app.get('/api/bill-fields', (req, res) => {
  const utility = req.query.utility;
  if (!utility) {
    return res.status(400).json({ error: "Falta el parámetro 'utility'" });
  }

  const query = "SELECT * FROM Utility_Bill_Fields WHERE Standard_Utility_Name = ?";
  req.db.query(query, [utility], (err, results) => {
    if (err) {
      console.error('Error ejecutando la consulta de bill-fields:', err);
      return res.status(500).json({ error: 'Error al obtener los campos de factura' });
    }
    res.json(results);
  });
});

const PORT = 3002;

// Código de arranque del servidor
if (process.env.NODE_ENV === 'production') {
  // En producción: HTTPS con certificados reales
  const httpsOptions = {
    key: fs.readFileSync('/etc/letsencrypt/live/nwfg.net/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/nwfg.net/fullchain.pem')
  };
  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`🚀 SERVER_RATES EN ${process.env.NODE_ENV} en https://nwfg.net:${PORT}`);
  });
} else {
  // En desarrollo: HTTP normal
  http.createServer(app).listen(PORT, () => {
    console.log(`🚀 SERVER_RATES EN ${process.env.NODE_ENV} en http://localhost:${PORT}`);
  });
}
