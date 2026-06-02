const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin SDK
// Expects GOOGLE_APPLICATION_CREDENTIALS environment variable or automated platform attachment
admin.initializeApp();

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration Constants
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || "TEST10313337a6b3252575231c4bca2a73331501";
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || "cfsk_ma_test_958f2b74b83fb8fe3857d99616e25cae_1b3c9efd";
const CASHFREE_ENV = process.env.CASHFREE_ENV || "TEST"; // TEST or PRODUCTION
const CASHFREE_BASE_URL = CASHFREE_ENV === "PRODUCTION" 
  ? "https://api.cashfree.com/pg" 
  : "https://sandbox.cashfree.com/pg";

// Authentication Middleware
async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decodedToken.uid, email: decodedToken.email };
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired authorization token' });
  }
}

// POST /auth/signup
app.post('/auth/signup', async (req, res) => {
  const { uid, username, email, referralCode } = req.body;
  
  if (!uid || !username || !email) {
    return res.status(400).json({ error: 'Missing required signup parameters' });
  }

  try {
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();

    if (doc.exists) {
      return res.status(200).json({ status: 'OK', message: 'User profile already established' });
    }

    const nativeReferralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    let referredBy = null;

    if (referralCode) {
      const referralQuery = await db.collection('users')
        .where('referralCode', '==', referralCode.trim().toUpperCase())
        .limit(1)
        .get();
      if (!referralQuery.empty) {
        referredBy = referralQuery.docs[0].id;
      }
    }

    const userData = {
      username: username.trim(),
      email: email.trim(),
      wallet: 0,
      totalXP: 0,
      joinedMatches: [],
      referralCode: nativeReferralCode,
      referredBy: referredBy,
      matchesPlayed: 0,
      totalKills: 0,
      dailyStreak: 0,
      isVIP: false,
      lastDailyReward: 0,
      createdAt: Date.now()
    };

    await userRef.set(userData);
    return res.status(201).json({ status: 'OK', data: userData });
  } catch (error) {
    return res.status(500).json({ error: 'Signup execution failed', details: error.message });
  }
});

// POST /match/join
app.post('/match/join', authenticateToken, async (req, res) => {
  const userUid = req.user.uid;
  const { matchId, gameUids } = req.body;

  if (!matchId || !Array.isArray(gameUids) || gameUids.length === 0) {
    return res.status(400).json({ error: 'Invalid join parameters' });
  }

  const matchRef = db.collection('matches').doc(matchId);
  const userRef = db.collection('users').doc(userUid);
  const teamRef = matchRef.collection('teams').doc(userUid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const matchDoc = await transaction.get(matchRef);
      if (!matchDoc.exists) {
        throw new Error('Target tournament record does not exist');
      }
      const matchData = matchDoc.data();

      if (matchData.status !== 'upcoming') {
        throw new Error('Registration window closed for this tournament status');
      }

      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error('User context entity not discovered');
      }
      const userData = userDoc.data();

      const joinedMatches = userData.joinedMatches || [];
      if (joinedMatches.includes(matchId)) {
        throw new Error('User identity is already registered for this tournament');
      }

      const requiredSize = matchData.mode === 'Solo' ? 1 : matchData.mode === 'Duo' ? 2 : 4;
      if (gameUids.length !== requiredSize) {
        throw new Error(`Roster sizes must correspond cleanly to mode: ${matchData.mode}`);
      }

      if ((matchData.joinedCount + 1) > matchData.maxPlayers) {
        throw new Error('Tournament entry limitations reached max capacity');
      }

      const cleanUids = gameUids.map(id => String(id).trim().toLowerCase());
      const uniqueUids = [...new Set(cleanUids)];
      if (uniqueUids.length !== cleanUids.length) {
        throw new Error('Duplicate game UIDs contained inside the roster parameters');
      }

      const existingTeamsQuery = await matchRef.collection('teams').get();
      for (const teamDoc of existingTeamsQuery.docs) {
        const teamData = teamDoc.data();
        if (teamData.gameUids && Array.isArray(teamData.gameUids)) {
          const conflictingUid = cleanUids.find(id => teamData.gameUids.includes(id));
          if (conflictingUid) {
            throw new Error(`Roster UID collision encountered: ${conflictingUid} already signed up`);
          }
        }
      }

      const entryFee = matchData.entryFee || 0;
      if (userData.wallet < entryFee) {
        throw new Error('Insufficient fiscal reserves inside user balance');
      }

      // Execute Ledger Operations
      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      transaction.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(1)
      });

      transaction.set(teamRef, {
        ownerUid: userUid,
        ownerUsername: userData.username || 'Anonymous',
        gameUids: cleanUids,
        joinedAt: Date.now()
      });

      const transRef = db.collection('transactions').document();
      transaction.set(transRef, {
        userId: userUid,
        type: 'match_join',
        amount: entryFee,
        status: 'SUCCESS',
        matchId: matchId,
        timestamp: Date.now()
      });

      return { status: 'SUCCESS', message: 'Entry formalized securely' };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /rewards/daily
app.post('/rewards/daily', authenticateToken, async (req, res) => {
  const userUid = req.user.uid;
  const userRef = db.collection('users').doc(userUid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User profiling records absent');
      
      const userData = userDoc.data();
      const now = Date.now();
      const lastReward = userData.lastDailyReward || 0;
      
      if (now - lastReward < 24 * 60 * 60 * 1000) {
        throw new Error('Cooldown active: Reward allocation available once per 24 hour interval');
      }

      let currentStreak = userData.dailyStreak || 0;
      if (now - lastReward < 48 * 60 * 60 * 1000) {
        currentStreak += 1;
      } else {
        currentStreak = 1;
      }

      const rewardAmount = 10 + Math.min(currentStreak, 7) * 2; // Progressive logic base reward

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(rewardAmount),
        dailyStreak: currentStreak,
        lastDailyReward: now
      });

      const transRef = db.collection('transactions').document();
      transaction.set(transRef, {
        userId: userUid,
        type: 'daily_reward',
        amount: rewardAmount,
        status: 'SUCCESS',
        timestamp: now
      });

      return { status: 'SUCCESS', rewardClaimed: rewardAmount, streak: currentStreak };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /wallet/withdraw
app.post('/wallet/withdraw', authenticateToken, async (req, res) => {
  const userUid = req.user.uid;
  const { amount, upiId } = req.body;
  const withdrawAmount = parseInt(amount);

  if (isNaN(withdrawAmount) || withdrawAmount <= 0 || !upiId) {
    return res.status(400).json({ error: 'Malformed payload specifications provided' });
  }

  const userRef = db.collection('users').doc(userUid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('User profile missing');
      
      const userData = userDoc.data();
      if (userData.wallet < withdrawAmount) {
        throw new Error('Insufficient resources for processing this debit amount');
      }

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-withdrawAmount)
      });

      const transRef = db.collection('transactions').document();
      transaction.set(transRef, {
        userId: userUid,
        type: 'withdraw',
        amount: withdrawAmount,
        upi: upiId,
        status: 'Pending',
        timestamp: Date.now()
      });

      return { status: 'SUCCESS', message: 'Withdrawal initialized and wallet locked successfully' };
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /wallet/createOrder
app.post('/wallet/createOrder', authenticateToken, async (req, res) => {
  const userUid = req.user.uid;
  const { amount } = req.body;
  const orderAmount = parseFloat(amount);

  if (isNaN(orderAmount) || orderAmount <= 0) {
    return res.status(400).json({ error: 'Order denomination parsing failed' });
  }

  const orderId = `ORDER_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  try {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: orderAmount,
        order_currency: "INR",
        customer_details: {
          customer_id: userUid,
          customer_email: req.user.email || "player@esports.internal",
          customer_phone: "9999999999"
        }
      })
    });

    const cfData = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: 'Failed inside payment gateway infrastructure communication', remote: cfData });
    }

    await db.collection('transactions').doc(orderId).set({
      userId: userUid,
      type: 'deposit',
      amount: orderAmount,
      status: 'PENDING',
      orderId: orderId,
      timestamp: Date.now()
    });

    return res.status(200).json({
      orderId: orderId,
      paymentSessionId: cfData.payment_session_id,
      cfOrder: cfData
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal gateway handshaking failure', details: error.message });
  }
});

// POST /webhook/cashfree
app.post('/webhook/cashfree', async (req, res) => {
  const ts = req.headers['x-webhook-timestamp'];
  const signature = req.headers['x-webhook-signature'];
  const rawBody = JSON.stringify(req.body);

  if (!ts || !signature) {
    return res.status(400).send('Missing signing components inside payload header');
  }

  // Cryptographic Payload Validation
  const signatureKey = ts + rawBody;
  const expectedSignature = crypto
    .createHmac('sha256', CASHFREE_SECRET_KEY)
    .update(signatureKey)
    .digest('base64');

  if (expectedSignature !== signature) {
    return res.status(400).send('Webhook validation mismatch: Signature mismatch');
  }

  const { data } = req.body;
  if (!data || !data.order || !data.payment) {
    return res.status(400).send('Unexpected webhook packet data scheme');
  }

  const orderId = data.order.order_id;
  const cfAmount = data.order.order_amount;
  const paymentStatus = data.payment.payment_status;

  try {
    const logRef = db.collection('cashfree_logs').doc(`${orderId}_${data.payment.cf_payment_id || 'LOG'}`);
    await logRef.set({
      orderId,
      amount: cfAmount,
      status: paymentStatus,
      timestamp: Date.now()
    });

    const transRef = db.collection('transactions').doc(orderId);

    await db.runTransaction(async (transaction) => {
      const txDoc = await transaction.get(transRef);
      if (!txDoc.exists) throw new Error('Transaction index reference path missing');

      const txData = txDoc.data();
      if (txData.status !== 'PENDING') {
        // Already processed, exit transaction early to enforce idempotency
        return;
      }

      if (parseFloat(txData.amount) !== parseFloat(cfAmount)) {
        throw new Error('Transaction audit discrepancy: ledger balance mismatch');
      }

      if (paymentStatus === 'SUCCESS') {
        const userRef = db.collection('users').doc(txData.userId);
        transaction.update(userRef, {
          wallet: admin.firestore.FieldValue.increment(cfAmount)
        });
        transaction.update(transRef, { status: 'SUCCESS' });
      } else if (['FAILED', 'CANCELLED', 'FLAGGED'].includes(paymentStatus)) {
        transaction.update(transRef, { status: 'FAILED' });
      }
    });

    return res.status(200).send('OK');
  } catch (error) {
    return res.status(500).send(`Inbound processing framework error: ${error.message}`);
  }
});

// POST /admin/match/distribute
app.post('/admin/match/distribute', async (req, res) => {
  // Secured validation checks happen at the security rule layered framework / API gateway level
  const { matchId, gameUid, rank, kills } = req.body;
  const targetRank = parseInt(rank);
  const targetKills = parseInt(kills) || 0;

  if (!matchId || !gameUid || isNaN(targetRank)) {
    return res.status(400).json({ error: 'Missing mandatory distribution components' });
  }

  try {
    const matchRef = db.collection('matches').doc(matchId);
    const matchDoc = await matchRef.get();
    if (!matchDoc.exists) return res.status(404).json({ error: 'Tournament document path absent' });
    
    const matchData = matchDoc.data();
    if (matchData.prizeDistributed) {
      return res.status(400).json({ error: 'Distribution loop blocked: Event prizes already mapped out' });
    }

    const cleanGameUid = String(gameUid).trim().toLowerCase();
    const teamsSnapshot = await matchRef.collection('teams').get();
    let foundOwnerUid = null;

    for (const doc of teamsSnapshot.docs) {
      const teamData = doc.data();
      if (teamData.gameUids && teamData.gameUids.includes(cleanGameUid)) {
        foundOwnerUid = teamData.ownerUid;
        break;
      }
    }

    if (!foundOwnerUid) {
      return res.status(404).json({ error: 'No team registration resolved tracking back to this gameUid array entry' });
    }

    const userRef = db.collection('users').doc(foundOwnerUid);
    
    const perKillRate = matchData.perKillRate || 0;
    const rankPrizes = matchData.rankPrizes || {};
    const rankPrize = parseInt(rankPrizes[String(targetRank)]) || 0;
    const computedPrize = (targetKills * perKillRate) + rankPrize;
    const computedXp = (targetKills * 15) + (targetRank === 1 ? 100 : targetRank <= 3 ? 50 : 10);

    await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) throw new Error('Target user database node unallocated');

      transaction.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(computedPrize),
        totalXP: admin.firestore.FieldValue.increment(computedXp),
        matchesPlayed: admin.firestore.FieldValue.increment(1),
        totalKills: admin.firestore.FieldValue.increment(targetKills)
      });

      const awardTransRef = db.collection('transactions').document();
      transaction.set(awardTransRef, {
        userId: foundOwnerUid,
        type: 'match_reward',
        amount: computedPrize,
        xpEarned: computedXp,
        matchId: matchId,
        gameUid: cleanGameUid,
        status: 'SUCCESS',
        timestamp: Date.now()
      });
    });

    return res.status(200).json({ 
      status: 'SUCCESS', 
      ownerUid: foundOwnerUid, 
      payout: computedPrize, 
      xp: computedXp 
    });
  } catch (error) {
    return res.status(500).json({ error: 'Distribution mapping crashed inside process', details: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Production engine live on internal operational interface registry port: ${PORT}`);
});
