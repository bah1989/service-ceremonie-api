// ============================================================
// SERVICE CÉRÉMONIE — Backend API (Node.js / Express)
// Déploiement : Railway
// Base de données : Supabase (appels REST directs, pas le SDK JS)
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3000;

async function sb(path, { method = 'GET', body, query = '' } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${query}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || 'Erreur Supabase');
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

function errHandler(res, e) {
  console.error(e);
  res.status(e.status && e.status < 500 ? 400 : 500).json({
    erreur: e.message || 'Erreur serveur',
    details: e.details || null,
  });
}

function hashPin(pin, telephone) {
  return crypto.createHash('sha256').update(`${telephone}:${pin}:sc-salt`).digest('hex');
}

app.post('/api/organisateurs', async (req, res) => {
  try {
    const { nom, telephone, pin } = req.body;
    if (!nom || !telephone || !pin) return res.status(400).json({ erreur: 'nom, telephone et pin requis' });
    const existant = await sb(`organisateurs?telephone=eq.${telephone}&select=id`);
    if (existant.length) return res.status(409).json({ erreur: 'Ce numéro est déjà enregistré' });
    const [organisateur] = await sb('organisateurs', {
      method: 'POST',
      body: { nom, telephone, pin_hash: hashPin(pin, telephone) },
    });
    delete organisateur.pin_hash;
    res.json(organisateur);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/organisateurs/login', async (req, res) => {
  try {
    const { telephone, pin } = req.body;
    if (!telephone || !pin) return res.status(400).json({ erreur: 'telephone et pin requis' });
    const [organisateur] = await sb(`organisateurs?telephone=eq.${telephone}`);
    if (!organisateur || organisateur.pin_hash !== hashPin(pin, telephone)) {
      return res.status(401).json({ erreur: 'Numéro ou code PIN incorrect' });
    }
    delete organisateur.pin_hash;
    res.json(organisateur);
  } catch (e) { errHandler(res, e); }
});

app.get('/api/organisateurs/:id/events', async (req, res) => {
  try {
    const events = await sb(`events?organisateur_id=eq.${req.params.id}&order=created_at.desc`);
    res.json(events);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/events', async (req, res) => {
  try {
    const { organisateur_id, nom, date_evenement, lieu, forfait, nb_invites_max } = req.body;
    if (!organisateur_id || !nom) return res.status(400).json({ erreur: 'organisateur_id et nom requis' });
    const [event] = await sb('events', {
      method: 'POST',
      body: { organisateur_id, nom, date_evenement, lieu, forfait: forfait || 'essai', nb_invites_max: nb_invites_max || 30 },
    });
    res.json(event);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/events/:id/confirmer-paiement', async (req, res) => {
  try {
    const { reference } = req.body;
    const [event] = await sb(`events?id=eq.${req.params.id}`, {
      method: 'PATCH',
      body: { paiement_statut: 'confirme', paiement_reference: reference || null, statut: 'actif' },
    });
    res.json(event);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/events/:id/menu', async (req, res) => {
  try {
    const { nom, ordre, categorie } = req.body;
    if (!nom || !ordre) return res.status(400).json({ erreur: 'nom et ordre requis' });
    const existants = await sb(`menu_items?event_id=eq.${req.params.id}&select=id`);
    if (existants.length >= 6) {
      return res.status(400).json({ erreur: 'Limite de 6 postes de menu atteinte pour cet événement' });
    }
    const [item] = await sb('menu_items', {
      method: 'POST',
      body: { event_id: req.params.id, nom, ordre, categorie: categorie || 'standard' },
    });
    res.json(item);
  } catch (e) { errHandler(res, e); }
});

app.get('/api/events/:id/menu', async (req, res) => {
  try {
    const items = await sb(`menu_items?event_id=eq.${req.params.id}&order=ordre.asc`);
    res.json(items);
  } catch (e) { errHandler(res, e); }
});

app.patch('/api/menu-items/:id', async (req, res) => {
  try {
    const { nom } = req.body;
    const [item] = await sb(`menu_items?id=eq.${req.params.id}`, { method: 'PATCH', body: { nom } });
    res.json(item);
  } catch (e) { errHandler(res, e); }
});

app.delete('/api/menu-items/:id', async (req, res) => {
  try {
    await sb(`menu_items?id=eq.${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { errHandler(res, e); }
});

app.post('/api/events/:id/guests', async (req, res) => {
  try {
    const { nom, type_acces, table_numero } = req.body;
    if (!nom) return res.status(400).json({ erreur: 'nom requis' });
    const [event] = await sb(`events?id=eq.${req.params.id}&select=nb_invites_max,paiement_statut`);
    if (!event) return res.status(404).json({ erreur: 'Événement introuvable' });
    if (event.paiement_statut !== 'confirme') {
      return res.status(402).json({ erreur: "Paiement de l'événement requis avant d'ajouter des invités" });
    }
    const existants = await sb(`guests?event_id=eq.${req.params.id}&select=id`);
    if (existants.length >= event.nb_invites_max) {
      return res.status(400).json({ erreur: `Limite du forfait atteinte (${event.nb_invites_max} invités max)` });
    }
    const qr_token = crypto.randomBytes(16).toString('hex');
    const [guest] = await sb('guests', {
      method: 'POST',
      body: { event_id: req.params.id, nom, type_acces: type_acces || 'standard', table_numero, qr_token },
    });
    res.json(guest);
  } catch (e) { errHandler(res, e); }
});

app.get('/api/events/:id/guests', async (req, res) => {
  try {
    const guests = await sb(`guests?event_id=eq.${req.params.id}&order=created_at.asc`);
    res.json(guests);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/guests/:id/revoquer', async (req, res) => {
  try {
    const [guest] = await sb(`guests?id=eq.${req.params.id}`, {
      method: 'PATCH', body: { qr_actif: false },
    });
    res.json(guest);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/staff/login', async (req, res) => {
  try {
    const { event_id, code_acces } = req.body;
    const [serveur] = await sb(`serveurs?event_id=eq.${event_id}&code_acces=eq.${code_acces}`);
    if (!serveur) return res.status(401).json({ erreur: "Code d'accès invalide" });
    res.json(serveur);
  } catch (e) { errHandler(res, e); }
});

app.post('/api/events/:id/serveurs', async (req, res) => {
  try {
    const { nom, code_acces } = req.body;
    const [serveur] = await sb('serveurs', {
      method: 'POST',
      body: { event_id: req.params.id, nom, code_acces },
    });
    res.json(serveur);
  } catch (e) { errHandler(res, e); }
});

app.get('/api/scan/:token', async (req, res) => {
  try {
    const [guest] = await sb(`guests?qr_token=eq.${req.params.token}&select=*`);
    if (!guest) return res.status(404).json({ erreur: 'QR code non reconnu' });
    if (!guest.qr_actif) return res.status(403).json({ erreur: 'Ce QR code a été révoqué' });
    const menu = await sb(`menu_items?event_id=eq.${guest.event_id}&order=ordre.asc`);
    const services = await sb(`services?guest_id=eq.${guest.id}&select=menu_item_id`);
    const servisIds = services.map(s => s.menu_item_id);
    res.json({
      guest,
      menu: menu.map(m => ({ ...m, servi: servisIds.includes(m.id) })),
    });
  } catch (e) { errHandler(res, e); }
});

app.post('/api/service', async (req, res) => {
  try {
    const { guest_id, menu_item_id, serveur_id } = req.body;
    if (!guest_id || !menu_item_id) return res.status(400).json({ erreur: 'guest_id et menu_item_id requis' });
    try {
      const [service] = await sb('services', {
        method: 'POST',
        body: { guest_id, menu_item_id, serveur_id: serveur_id || null },
      });
      res.json({ ok: true, service });
    } catch (e) {
      if (e.details?.code === '23505') {
        return res.status(409).json({ erreur: 'Ce poste a déjà été servi à cet invité' });
      }
      throw e;
    }
  } catch (e) { errHandler(res, e); }
});

app.delete('/api/service', async (req, res) => {
  try {
    const { guest_id, menu_item_id } = req.body;
    await sb(`services?guest_id=eq.${guest_id}&menu_item_id=eq.${menu_item_id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) { errHandler(res, e); }
});

app.get('/api/events/:id/suivi', async (req, res) => {
  try {
    const rows = await sb(`v_suivi_event?event_id=eq.${req.params.id}`);
    res.json(rows);
  } catch (e) { errHandler(res, e); }
});

app.get('/', (req, res) => res.send('Service Cérémonie API — OK'));
app.listen(PORT, () => console.log(`API démarrée sur le port ${PORT}`));
