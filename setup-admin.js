#!/usr/bin/env node
/**
 * SAO Admin User Setup Script
 * Connects to database and creates the admin user if not already present.
 * Usage: node setup-admin.js [email] [password]
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

async function createAdmin() {
  const email = process.argv[2] || process.env.SAO_ADMIN_EMAIL || 'admin@sao.system';
  const password = process.argv[3] || process.env.SAO_ADMIN_PASSWORD || 'SAOAdmin2026!';

  console.log('SAO Admin Setup');
  console.log('===============');
  console.log('Email: ' + email);

  let connectionConfig = {};

  if (process.env.DB_HOST) {
    connectionConfig = {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'sao',
    };
  } else if (process.env.DATABASE_URL) {
    try {
      const parsed = new URL(process.env.DATABASE_URL);
      connectionConfig = {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10) || 3306,
        user: parsed.username,
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.slice(1),
      };
    } catch (e) {
      connectionConfig = { uri: process.env.DATABASE_URL };
    }
  } else {
    connectionConfig = {
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: '',
      database: 'sao',
    };
  }

  let connection;
  try {
    connection = await mysql.createConnection(connectionConfig);
    console.log('Connected to database successfully.');
  } catch (err) {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  }

  try {
    // Check if user already exists
    const [existing] = await connection.execute(
      'SELECT id, email, role FROM users WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      console.log('\u26A0\uFE0F  User already exists with email: ' + email + ' (Role: ' + existing[0].role + ')');
      console.log('Skipping user creation.');
      await connection.end();
      return;
    }

    // Hash password and insert user
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const userId = crypto.randomUUID();

    await connection.execute(
      'INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [userId, email, passwordHash, 'admin']
    );

    console.log('\u2705 Admin user created successfully!');
    console.log('   ID: ' + userId);
    console.log('   Email: ' + email);
    console.log('   Role: admin');
  } catch (err) {
    console.error('\u274C Error setting up admin user:', err.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

createAdmin().catch((err) => {
  console.error('\u274C Unexpected error:', err.message);
  process.exit(1);
});
