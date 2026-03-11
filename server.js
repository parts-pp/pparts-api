import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.PORT || 3000;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

function nowIso() {
  return new Date().toISOString();
}

function safePublicId(prefix = "USR") {
  const rnd = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${rnd}`;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").trim();
}

function isValidSaudiPhone(phone) {
  return /^05\d{8}$/.test(phone);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function comparePassword(password, hashed) {
  return hashPassword(password) === hashed;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail({ to, code }) {
  if (!resend || !process.env.RESEND_FROM_EMAIL) {
    console.log("[OTP EMAIL FALLBACK]", { to, code });
    return { sent: false, fallback: true };
  }

  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: [to],
    subject: "رمز التحقق - PParts",
    html: `
      <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right;">
        <h2>رمز التحقق</h2>
        <p>رمز التحقق الخاص بك هو:</p>
        <div style="font-size: 32px; font-weight: bold; margin: 16px 0;">${code}</div>
        <p>صلاحية الرمز 10 دقائق.</p>
      </div>
    `,
  });

  if (error) throw new Error(error.message || "Failed to send email OTP");
  return { sent: true, data };
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getRequestIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

function getRequestUserAgent(req) {
  return req.headers["user-agent"] || null;
}

async function writeAuditLog({
  actor_user_id = null,
  actor_role = null,
  action_type,
  entity_type,
  entity_id = null,
  entity_public_no = null,
  old_values_json = null,
  new_values_json = null,
  source_channel = "api",
}) {
  try {
    await supabase.from("audit_logs").insert({
      actor_user_id,
      actor_role,
      action_type,
      entity_type,
      entity_id,
      entity_public_no,
      old_values_json,
      new_values_json,
      source_channel,
      created_at: nowIso(),
    });
  } catch (err) {
    console.error("audit_logs insert failed:", err.message);
  }
}

async function createOtpRecord({
  user_id,
  channel,
  target_value,
  purpose,
}) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 10).toISOString();

  const { data, error } = await supabase
    .from("otp_codes")
    .insert({
      user_id,
      channel,
      target_value,
      purpose,
      code,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) throw error;

  if (channel === "email") {
    await sendOtpEmail({ to: target_value, code });
  }

  return data;
}

async function createUserSession({ user, req, rememberMe = false }) {
  const sessionToken = generateSessionToken();
  const expiresAt = new Date(
    Date.now() + (rememberMe ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 24)
  ).toISOString();

  const { data, error } = await supabase
    .from("user_sessions")
    .insert({
      user_id: user.id,
      session_token: sessionToken,
      remember_me: rememberMe,
      ip_address: getRequestIp(req),
      user_agent: getRequestUserAgent(req),
      expires_at: expiresAt,
      last_seen_at: nowIso(),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getSessionWithUser(sessionToken) {
  const { data, error } = await supabase
    .from("user_sessions")
    .select(`
      *,
      user:users(*)
    `)
    .eq("session_token", sessionToken)
    .eq("is_revoked", false)
    .single();

  if (error || !data) return null;

  if (new Date(data.expires_at).getTime() < Date.now()) {
    await supabase
      .from("user_sessions")
      .update({ is_revoked: true })
      .eq("id", data.id);
    return null;
  }

  await supabase
    .from("user_sessions")
    .update({ last_seen_at: nowIso() })
    .eq("id", data.id);

  return data;
}

app.get("/health", async (_req, res) => {
  return res.json({
    success: true,
    message: "PParts API is healthy",
    timestamp: nowIso(),
  });
});

app.post("/auth/register-client", async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || "").trim();
    const phone = normalizePhone(req.body?.phone);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: "الاسم الكامل مطلوب",
      });
    }

    if (!isValidSaudiPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "رقم الجوال يجب أن يبدأ بـ 05 ويتكون من 10 أرقام",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "البريد الإلكتروني غير صحيح",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "كلمة المرور يجب أن تكون 6 أحرف على الأقل",
      });
    }

    const { data: existingPhone } = await supabase
      .from("users")
      .select("id")
      .eq("phone", phone)
      .limit(1);

    if (existingPhone && existingPhone.length > 0) {
      return res.status(409).json({
        success: false,
        message: "رقم الجوال مسجل مسبقًا",
      });
    }

    const { data: existingEmail } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .limit(1);

    if (existingEmail && existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: "البريد الإلكتروني مسجل مسبقًا",
      });
    }

    const public_id = safePublicId("USR");
    const password_hash = hashPassword(password);

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        public_id,
        full_name,
        first_name: full_name.split(" ")[0] || null,
        last_name: full_name.split(" ").slice(1).join(" ") || null,
        phone,
        email,
        password_hash,
        role: "client",
        account_status: "active",
        is_verified: false,
        is_phone_verified: false,
        is_email_verified: false,
        preferred_language: "ar",
        country_code: "SA",
        timezone: "Asia/Riyadh",
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from("client_profiles").insert({
      user_id: user.id,
      client_code: safePublicId("CLT"),
      default_contact_name: full_name,
      default_phone: phone,
    });

    const emailOtp = await createOtpRecord({
      user_id: user.id,
      channel: "email",
      target_value: email,
      purpose: "register",
    });

    await writeAuditLog({
      actor_user_id: user.id,
      actor_role: "client",
      action_type: "create",
      entity_type: "user",
      entity_id: user.id,
      entity_public_no: user.public_id,
      new_values_json: {
        role: "client",
        full_name,
        phone,
        email,
      },
      source_channel: "web",
    });

    return res.status(201).json({
      success: true,
      message: "تم إنشاء الحساب وإرسال رمز التحقق إلى البريد الإلكتروني",
      user: {
        id: user.id,
        public_id: user.public_id,
        full_name: user.full_name,
        phone: user.phone,
        email: user.email,
        role: user.role,
      },
      verification: {
        email_required: true,
        email_demo_code: emailOtp.code,
      },
    });
  } catch (err) {
    console.error("POST /auth/register-client error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "تعذر إنشاء الحساب",
    });
  }
});

app.post("/auth/register-trader", async (req, res) => {
  try {
    const store_name = String(req.body?.store_name || "").trim();
    const contact_name = String(req.body?.contact_name || "").trim();
    const phone = normalizePhone(req.body?.phone);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const city = String(req.body?.city || "").trim();
    const address = String(req.body?.address || "").trim();
    const description = String(req.body?.description || "").trim();
    const commercial_registration_no = String(
      req.body?.commercial_registration_no || ""
    ).trim();
    const license_url = String(req.body?.license_url || "").trim();
    const cr_doc_url = String(req.body?.cr_doc_url || "").trim();
    const vat_no = String(req.body?.vat_no || "").trim();
    const iban = String(req.body?.iban || "").trim();
    const stc_pay_no = String(req.body?.stc_pay_no || "").trim();

    if (!store_name || !contact_name) {
      return res.status(400).json({
        success: false,
        message: "اسم المتجر واسم المسؤول مطلوبان",
      });
    }

    if (!isValidSaudiPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "رقم الجوال يجب أن يبدأ بـ 05 ويتكون من 10 أرقام",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "البريد الإلكتروني غير صحيح",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "كلمة المرور يجب أن تكون 6 أحرف على الأقل",
      });
    }

    if (!commercial_registration_no) {
      return res.status(400).json({
        success: false,
        message: "رقم السجل التجاري مطلوب",
      });
    }

    if (!cr_doc_url || !license_url) {
      return res.status(400).json({
        success: false,
        message: "رابط السجل التجاري ورخصة المحل مطلوبان في هذه المرحلة",
      });
    }

    const { data: existingPhone } = await supabase
      .from("users")
      .select("id")
      .eq("phone", phone)
      .limit(1);

    if (existingPhone && existingPhone.length > 0) {
      return res.status(409).json({
        success: false,
        message: "رقم الجوال مسجل مسبقًا",
      });
    }

    const { data: existingEmail } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .limit(1);

    if (existingEmail && existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: "البريد الإلكتروني مسجل مسبقًا",
      });
    }

    const public_id = safePublicId("USR");
    const password_hash = hashPassword(password);

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        public_id,
        full_name: contact_name,
        first_name: contact_name.split(" ")[0] || null,
        last_name: contact_name.split(" ").slice(1).join(" ") || null,
        phone,
        email,
        password_hash,
        role: "trader",
        account_status: "pending",
        is_verified: false,
        is_phone_verified: false,
        is_email_verified: false,
        city: city || null,
        preferred_language: "ar",
        country_code: "SA",
        timezone: "Asia/Riyadh",
      })
      .select()
      .single();

    if (error) throw error;

    const { data: traderProfile, error: traderError } = await supabase
      .from("trader_profiles")
      .insert({
        user_id: user.id,
        trader_code: safePublicId("TRD"),
        store_name,
        legal_name: store_name,
        contact_name,
        contact_phone: phone,
        city: city || null,
        address: address || null,
        description: description || null,
        commercial_registration_no,
        vat_no: vat_no || null,
        iban: iban || null,
        stc_pay_no: stc_pay_no || null,
        trader_status: "pending_review",
        approval_status: "pending",
        can_quote: false,
        can_receive_orders: false,
        subscription_required: true,
        platform_fee_required: true,
      })
      .select()
      .single();

    if (traderError) throw traderError;

    await supabase.from("trader_documents").insert([
      {
        trader_id: traderProfile.id,
        document_type: "cr",
        document_title: "السجل التجاري",
        file_url: cr_doc_url,
        verification_status: "pending",
      },
      {
        trader_id: traderProfile.id,
        document_type: "license",
        document_title: "رخصة المحل",
        file_url: license_url,
        verification_status: "pending",
      },
    ]);

    const emailOtp = await createOtpRecord({
      user_id: user.id,
      channel: "email",
      target_value: email,
      purpose: "register",
    });

    await writeAuditLog({
      actor_user_id: user.id,
      actor_role: "trader",
      action_type: "create",
      entity_type: "trader",
      entity_id: traderProfile.id,
      entity_public_no: traderProfile.trader_code,
      new_values_json: {
        store_name,
        phone,
        email,
        commercial_registration_no,
      },
      source_channel: "web",
    });

    return res.status(201).json({
      success: true,
      message: "تم تسجيل التاجر وإرسال رمز التحقق إلى البريد الإلكتروني",
      user: {
        id: user.id,
        public_id: user.public_id,
        full_name: user.full_name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        account_status: user.account_status,
      },
      trader_profile: {
        id: traderProfile.id,
        trader_code: traderProfile.trader_code,
        store_name: traderProfile.store_name,
        trader_status: traderProfile.trader_status,
        approval_status: traderProfile.approval_status,
      },
      verification: {
        email_required: true,
        email_demo_code: emailOtp.code,
      },
    });
  } catch (err) {
    console.error("POST /auth/register-trader error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "تعذر تسجيل التاجر",
    });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const login = String(req.body?.login || "").trim();
    const password = String(req.body?.password || "");
    const remember_me = Boolean(req.body?.remember_me || false);

    if (!login || !password) {
      return res.status(400).json({
        success: false,
        message: "بيانات الدخول مطلوبة",
      });
    }

    const loginEmail = normalizeEmail(login);
    const loginPhone = normalizePhone(login);

    let query = supabase.from("users").select("*").limit(1);

    if (isValidEmail(loginEmail)) {
      query = supabase
        .from("users")
        .select("*")
        .eq("email", loginEmail)
        .limit(1);
    } else {
      query = supabase
        .from("users")
        .select("*")
        .eq("phone", loginPhone)
        .limit(1);
    }

    const { data: users, error } = await query;
    if (error) throw error;

    if (!users || users.length === 0) {
      return res.status(401).json({
        success: false,
        message: "بيانات الدخول غير صحيحة",
      });
    }

    const user = users[0];

    if (!user.password_hash || !comparePassword(password, user.password_hash)) {
      return res.status(401).json({
        success: false,
        message: "بيانات الدخول غير صحيحة",
      });
    }

    const requiresVerification = !user.is_email_verified;

    if (requiresVerification) {
      if (user.email) {
        await createOtpRecord({
          user_id: user.id,
          channel: "email",
          target_value: user.email,
          purpose: "login",
        });
      }

      return res.status(403).json({
        success: false,
        requires_verification: true,
        message: "يجب التحقق من البريد الإلكتروني أولًا",
        user: {
          id: user.id,
          full_name: user.full_name,
          phone: user.phone,
          email: user.email,
          role: user.role,
        },
        verification: {
          email_required: !user.is_email_verified,
        },
      });
    }

    await supabase
      .from("users")
      .update({
        last_login_at: nowIso(),
        last_seen_at: nowIso(),
      })
      .eq("id", user.id);

    const session = await createUserSession({
      user,
      req,
      rememberMe: remember_me,
    });

    await writeAuditLog({
      actor_user_id: user.id,
      actor_role: user.role,
      action_type: "login",
      entity_type: "user",
      entity_id: user.id,
      entity_public_no: user.public_id,
      new_values_json: {
        last_login_at: nowIso(),
      },
      source_channel: "web",
    });

    return res.json({
      success: true,
      message: "تم تسجيل الدخول بنجاح",
      session: {
        token: session.session_token,
        expires_at: session.expires_at,
        remember_me: session.remember_me,
      },
      user: {
        id: user.id,
        public_id: user.public_id,
        full_name: user.full_name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        account_status: user.account_status,
      },
    });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "تعذر تسجيل الدخول",
    });
  }
});

app.post("/auth/resend-otp", async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "").trim();
    const channel = String(req.body?.channel || "").trim();

    if (!user_id || channel !== "email") {
      return res.status(400).json({
        success: false,
        message: "بيانات إعادة الإرسال غير مكتملة",
      });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, is_email_verified")
      .eq("id", user_id)
      .single();

    if (error || !user) {
      return res.status(404).json({
        success: false,
        message: "المستخدم غير موجود",
      });
    }

    if (user.is_email_verified) {
      return res.status(400).json({
        success: false,
        message: "تم التحقق من البريد بالفعل",
      });
    }

    if (!user.email) {
      return res.status(400).json({
        success: false,
        message: "لا يوجد بريد إلكتروني لهذا الحساب",
      });
    }

    await createOtpRecord({
      user_id,
      channel: "email",
      target_value: user.email,
      purpose: "resend",
    });

    return res.json({
      success: true,
      message: "تمت إعادة إرسال رمز البريد الإلكتروني",
    });
  } catch (err) {
    console.error("POST /auth/resend-otp error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "تعذر إعادة إرسال الرمز",
    });
  }
});

app.post("/auth/verify", async (req, res) => {
  try {
    const user_id = String(req.body?.user_id || "").trim();
    const channel = String(req.body?.channel || "").trim();
    const code = String(req.body?.code || "").trim();

    if (!user_id || !channel || !code) {
      return res.status(400).json({
        success: false,
        message: "بيانات التحقق ناقصة",
      });
    }

    if (channel !== "email") {
      return res.status(400).json({
        success: false,
        message: "التحقق المتاح حاليًا عبر البريد الإلكتروني فقط",
      });
    }

    const { data: otpRows, error } = await supabase
      .from("otp_codes")
      .select("*")
      .eq("user_id", user_id)
      .eq("channel", channel)
      .eq("code", code)
      .is("verified_at", null)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    if (!otpRows || otpRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "رمز التحقق غير صحيح",
      });
    }

    const otp = otpRows[0];

    if (new Date(otp.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: "انتهت صلاحية رمز التحقق",
      });
    }

    await supabase
      .from("otp_codes")
      .update({ verified_at: nowIso() })
      .eq("id", otp.id);

    await supabase
      .from("users")
      .update({
        is_email_verified: true,
        is_verified: true,
      })
      .eq("id", user_id);

    return res.json({
      success: true,
      message: "تم التحقق بنجاح",
      verification: {
        is_email_verified: true,
      },
    });
  } catch (err) {
    console.error("POST /auth/verify error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "تعذر التحقق",
    });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "لا توجد جلسة",
      });
    }

    const session = await getSessionWithUser(token);

    if (!session || !session.user) {
      return res.status(401).json({
        success: false,
        message: "الجلسة غير صالحة",
      });
    }

    return res.json({
      success: true,
      user: {
        id: session.user.id,
        public_id: session.user.public_id,
        full_name: session.user.full_name,
        phone: session.user.phone,
        email: session.user.email,
        role: session.user.role,
        account_status: session.user.account_status,
        is_verified: session.user.is_verified,
        is_phone_verified: session.user.is_phone_verified,
        is_email_verified: session.user.is_email_verified,
      },
    });
  } catch (err) {
    console.error("GET /auth/me error:", err);
    return res.status(500).json({
      success: false,
      message: "تعذر جلب الجلسة",
    });
  }
});

app.listen(port, () => {
  console.log(`PParts API running on port ${port}`);
});
