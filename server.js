import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

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

function nowIso() {
    return new Date().toISOString();
}

function safePublicId(prefix = "USR") {
    const rnd = crypto.randomBytes(4).toString("hex").toUpperCase();
    return `${prefix}-${rnd}`;
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

async function getOrCreateClientUser({
    telegram_id = null,
    phone = null,
    email = null,
    full_name = null,
    city = null,
}) {
    let query = null;

    if (telegram_id) {
        query = supabase
            .from("users")
            .select("*")
            .eq("telegram_id", String(telegram_id))
            .limit(1);
    } else if (email) {
        query = supabase
            .from("users")
            .select("*")
            .eq("email", email)
            .limit(1);
    } else if (phone) {
        query = supabase
            .from("users")
            .select("*")
            .eq("phone", phone)
            .limit(1);
    }

    if (query) {
        const { data: existing, error: existingError } = await query;
        if (existingError) throw existingError;
        if (existing && existing.length > 0) return existing[0];
    }

    const publicId = safePublicId("USR");

    const { data: created, error: createError } = await supabase
        .from("users")
        .insert({
            public_id: publicId,
            telegram_id: telegram_id ? String(telegram_id) : null,
            email,
            phone,
            full_name,
            first_name: full_name ? full_name.split(" ")[0] : null,
            last_name: full_name ? full_name.split(" ").slice(1).join(" ") || null : null,
            role: "client",
            account_status: "active",
            city,
            preferred_language: "ar",
            country_code: "SA",
            timezone: "Asia/Riyadh",
        })
        .select()
        .single();

    if (createError) throw createError;

    await supabase.from("client_profiles").insert({
        user_id: created.id,
        client_code: safePublicId("CLT"),
        default_contact_name: full_name,
        default_phone: phone,
        preferred_city: city,
    });

    await writeAuditLog({
        actor_user_id: created.id,
        actor_role: "client",
        action_type: "create",
        entity_type: "user",
        entity_id: created.id,
        entity_public_no: created.public_id,
        new_values_json: created,
    });

    return created;
}

async function createVehicleIfNeeded({
    user_id,
    make,
    model,
    year,
    trim = null,
    engine = null,
    transmission = null,
    fuel_type = null,
    drive_type = null,
    vin = null,
    plate_no = null,
    color = null,
    notes = null,
}) {
    if (!make && !model && !year && !vin) {
        return null;
    }

    const { data, error } = await supabase
        .from("vehicles")
        .insert({
            user_id,
            make,
            model,
            year: year ? String(year) : null,
            trim,
            engine,
            transmission,
            fuel_type,
            drive_type,
            vin,
            plate_no,
            color,
            notes,
            is_default: false,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function generateOrderNo() {
    const year = new Date().getFullYear();
    const prefix = `PP-${year}-`;

    const { data, error } = await supabase
        .from("orders")
        .select("order_no")
        .ilike("order_no", `${prefix}%`)
        .order("created_at", { ascending: false })
        .limit(1);

    if (error) throw error;

    let nextSeq = 1;

    if (data && data.length > 0 && data[0].order_no) {
        const parts = String(data[0].order_no).split("-");
        const lastPart = parts[2] || "0";
        const parsed = parseInt(lastPart, 10);
        if (!Number.isNaN(parsed)) nextSeq = parsed + 1;
    }

    return `${prefix}${String(nextSeq).padStart(8, "0")}`;
}

async function recalcOrderTotals(orderId) {
    const { data: items, error: itemsError } = await supabase
        .from("order_items")
        .select("id")
        .eq("order_id", orderId);

    if (itemsError) throw itemsError;

    const itemsCount = items?.length || 0;

    const { error: updateError } = await supabase
        .from("orders")
        .update({
            items_count: itemsCount,
            updated_at: nowIso(),
        })
        .eq("id", orderId);

    if (updateError) throw updateError;
}

async function appendOrderStatusHistory({
    order_id,
    old_status,
    new_status,
    changed_by_user_id = null,
    changed_by_role = null,
    source = "api",
    note = null,
    metadata_json = null,
}) {
    const { error } = await supabase.from("order_status_history").insert({
        order_id,
        old_status,
        new_status,
        changed_by_user_id,
        changed_by_role,
        source,
        note,
        metadata_json,
        created_at: nowIso(),
    });

    if (error) throw error;
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


app.get("/", async (req, res) => {
    return res.json({
        success: true,
        service: "PParts API",
        status: "running",
        time: nowIso(),
    });
});

app.get("/health", async (req, res) => {
    try {
        const { error } = await supabase.from("app_settings").select("id").limit(1);
        if (error) throw error;

        return res.json({
            success: true,
            status: "ok",
            database: "connected",
            time: nowIso(),
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            status: "error",
            message: err.message,
        });
    }
});

app.post("/orders", async (req, res) => {
    try {
        const {
            source_channel = "web",
            actor_user_id = null,
            actor_role = "client",

            client = {},
            vehicle = {},
            order = {},
            items = [],
        } = req.body || {};

        if (!client || (!client.telegram_id && !client.phone && !client.email)) {
            return res.status(400).json({
                success: false,
                message: "client.telegram_id or client.phone or client.email is required",
            });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "At least one item is required",
            });
        }

        const user = await getOrCreateClientUser({
            telegram_id: client.telegram_id || null,
            phone: client.phone || null,
            email: client.email || null,
            full_name: client.full_name || null,
            city: client.city || order.city || null,
        });

        const vehicleRow = await createVehicleIfNeeded({
            user_id: user.id,
            make: vehicle.make || null,
            model: vehicle.model || null,
            year: vehicle.year || null,
            trim: vehicle.trim || null,
            engine: vehicle.engine || null,
            transmission: vehicle.transmission || null,
            fuel_type: vehicle.fuel_type || null,
            drive_type: vehicle.drive_type || null,
            vin: vehicle.vin || null,
            plate_no: vehicle.plate_no || null,
            color: vehicle.color || null,
            notes: vehicle.notes || null,
        });

        const orderNo = await generateOrderNo();
        const orderUuid = crypto.randomUUID();

        const { data: createdOrder, error: orderError } = await supabase
            .from("orders")
            .insert({
                order_uuid: orderUuid,
                order_no: orderNo,
                client_id: user.id,
                vehicle_id: vehicleRow?.id || null,
                source_channel,
                request_type: order.request_type || "parts",
                order_status: "submitted",
                priority_level: order.priority_level || "normal",
                visibility_status: order.visibility_status || "private",
                city: order.city || client.city || null,
                delivery_type: order.delivery_type || "shipping",
                delivery_address: order.delivery_address || null,
                postcode: order.postcode || null,
                client_notes: order.client_notes || null,
                internal_notes: order.internal_notes || null,
                currency: "SAR",
                payment_status: "unpaid",
                last_status_at: nowIso(),
                expires_at: order.expires_at || null,
            })
            .select()
            .single();

        if (orderError) throw orderError;

        for (let i = 0; i < items.length; i += 1) {
            const item = items[i] || {};

            const { error: itemError } = await supabase.from("order_items").insert({
                order_id: createdOrder.id,
                line_no: i + 1,
                item_type: item.item_type || "spare_part",
                item_name: item.item_name,
                normalized_name: item.normalized_name || null,
                part_number: item.part_number || null,
                brand: item.brand || null,
                requested_condition: item.requested_condition || "any",
                quantity: item.quantity || 1,
                unit: item.unit || "piece",
                notes: item.notes || null,
                image_url: item.image_url || null,
                reference_url: item.reference_url || null,
                is_consumable: Boolean(item.is_consumable || false),
                is_urgent: Boolean(item.is_urgent || false),
            });

            if (itemError) throw itemError;
        }

        await recalcOrderTotals(createdOrder.id);

        await appendOrderStatusHistory({
            order_id: createdOrder.id,
            old_status: null,
            new_status: "submitted",
            changed_by_user_id: actor_user_id || user.id,
            changed_by_role: actor_role || "client",
            source: source_channel,
            note: "Order created",
            metadata_json: {
                order_no: createdOrder.order_no,
            },
        });

        await writeAuditLog({
            actor_user_id: actor_user_id || user.id,
            actor_role: actor_role || "client",
            action_type: "create",
            entity_type: "order",
            entity_id: createdOrder.id,
            entity_public_no: createdOrder.order_no,
            new_values_json: {
                order_no: createdOrder.order_no,
                client_id: createdOrder.client_id,
                status: createdOrder.order_status,
            },
            source_channel,
        });

        const { data: fullOrder, error: fetchError } = await supabase
            .from("orders")
            .select(`
        *,
        client:users!orders_client_id_fkey(id, public_id, full_name, phone, email, role),
        vehicle:vehicles(*),
        items:order_items(*)
      `)
            .eq("id", createdOrder.id)
            .single();

        if (fetchError) throw fetchError;

        return res.status(201).json({
            success: true,
            message: "Order created successfully",
            order: fullOrder,
        });
    } catch (err) {
        console.error("POST /orders error:", err);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

app.post("/orders/:orderId/items", async (req, res) => {
    try {
        const { orderId } = req.params;
        const item = req.body || {};

        if (!item.item_name) {
            return res.status(400).json({
                success: false,
                message: "item_name is required",
            });
        }

        const { data: existingItems, error: existingError } = await supabase
            .from("order_items")
            .select("id")
            .eq("order_id", orderId);

        if (existingError) throw existingError;

        const nextLine = (existingItems?.length || 0) + 1;

        const { data: createdItem, error: itemError } = await supabase
            .from("order_items")
            .insert({
                order_id: orderId,
                line_no: nextLine,
                item_type: item.item_type || "spare_part",
                item_name: item.item_name,
                normalized_name: item.normalized_name || null,
                part_number: item.part_number || null,
                brand: item.brand || null,
                requested_condition: item.requested_condition || "any",
                quantity: item.quantity || 1,
                unit: item.unit || "piece",
                notes: item.notes || null,
                image_url: item.image_url || null,
                reference_url: item.reference_url || null,
                is_consumable: Boolean(item.is_consumable || false),
                is_urgent: Boolean(item.is_urgent || false),
            })
            .select()
            .single();

        if (itemError) throw itemError;

        await recalcOrderTotals(orderId);

        await writeAuditLog({
            action_type: "create",
            entity_type: "order_item",
            entity_id: createdItem.id,
            new_values_json: createdItem,
            source_channel: "api",
        });

        return res.status(201).json({
            success: true,
            item: createdItem,
        });
    } catch (err) {
        console.error("POST /orders/:orderId/items error:", err);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

app.get("/orders/:orderNo", async (req, res) => {
    try {
        const { orderNo } = req.params;

        const { data, error } = await supabase
            .from("orders")
            .select(`
        *,
        client:users!orders_client_id_fkey(id, public_id, full_name, phone, email, role),
        assigned_trader:users!orders_assigned_trader_id_fkey(id, public_id, full_name, phone, email, role),
        vehicle:vehicles(*),
        items:order_items(*),
        attachments:order_attachments(*),
        status_history:order_status_history(*),
        quotes:quotes(
          *,
          trader:users!quotes_trader_id_fkey(id, public_id, full_name, phone, email, role),
          items:quote_items(*)
        )
      `)
            .eq("order_no", orderNo)
            .single();

        if (error) {
            return res.status(404).json({
                success: false,
                message: "Order not found",
            });
        }

        return res.json({
            success: true,
            order: data,
        });
    } catch (err) {
        console.error("GET /orders/:orderNo error:", err);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

app.patch("/orders/:orderId/status", async (req, res) => {
    try {
        const { orderId } = req.params;
        const {
            new_status,
            actor_user_id = null,
            actor_role = null,
            source = "api",
            note = null,
        } = req.body || {};

        if (!new_status) {
            return res.status(400).json({
                success: false,
                message: "new_status is required",
            });
        }

        const { data: orderRow, error: fetchError } = await supabase
            .from("orders")
            .select("*")
            .eq("id", orderId)
            .single();

        if (fetchError || !orderRow) {
            return res.status(404).json({
                success: false,
                message: "Order not found",
            });
        }

        const oldStatus = orderRow.order_status;

        const updatePayload = {
            order_status: new_status,
            last_status_at: nowIso(),
            updated_at: nowIso(),
        };

        if (new_status === "cancelled") {
            updatePayload.cancelled_at = nowIso();
            updatePayload.cancelled_by = actor_user_id || null;
            updatePayload.cancellation_reason = note || null;
        }

        if (new_status === "completed") {
            updatePayload.completed_at = nowIso();
            updatePayload.completed_by = actor_user_id || null;
            updatePayload.closed_at = nowIso();
        }

        const { data: updatedOrder, error: updateError } = await supabase
            .from("orders")
            .update(updatePayload)
            .eq("id", orderId)
            .select()
            .single();

        if (updateError) throw updateError;

        await appendOrderStatusHistory({
            order_id: orderId,
            old_status: oldStatus,
            new_status,
            changed_by_user_id: actor_user_id,
            changed_by_role: actor_role,
            source,
            note,
        });

        await writeAuditLog({
            actor_user_id,
            actor_role,
            action_type: "change_status",
            entity_type: "order",
            entity_id: updatedOrder.id,
            entity_public_no: updatedOrder.order_no,
            old_values_json: { order_status: oldStatus },
            new_values_json: { order_status: new_status },
            source_channel: source,
        });

        return res.json({
            success: true,
            message: "Order status updated",
            order: updatedOrder,
        });
    } catch (err) {
        console.error("PATCH /orders/:orderId/status error:", err);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

app.get("/orders/:orderNo/status-history", async (req, res) => {
    try {
        const { orderNo } = req.params;

        const { data: orderRow, error: orderError } = await supabase
            .from("orders")
            .select("id, order_no")
            .eq("order_no", orderNo)
            .single();

        if (orderError || !orderRow) {
            return res.status(404).json({
                success: false,
                message: "Order not found",
            });
        }

        const { data, error } = await supabase
            .from("order_status_history")
            .select("*")
            .eq("order_id", orderRow.id)
            .order("created_at", { ascending: true });

        if (error) throw error;

        return res.json({
            success: true,
            order_no: orderRow.order_no,
            history: data || [],
        });
    } catch (err) {
        console.error("GET /orders/:orderNo/status-history error:", err);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

app.get("/clients/:userId/orders", async (req, res) => {
    try {
        const { userId } = req.params;

        const { data, error } = await supabase
            .from("orders")
            .select(`
        *,
        vehicle:vehicles(*),
        items:order_items(*)
      `)
            .eq("client_id", userId)
            .order("created_at", { ascending: false });

        if (error) throw error;

        return res.json({
            success: true,
            orders: data || [],
        });
    } catch (err) {
        console.error("GET /clients/:userId/orders error:", err);
        return res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

app.post("/auth/register-client", async (req, res) => {
    try {
        const full_name = String(req.body?.full_name || "").trim();
        const phone = normalizePhone(req.body?.phone);
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || "");

        if (!full_name) {
            return res.status(400).json({ success: false, message: "الاسم مطلوب" });
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
            message: "تم إنشاء حساب العميل بنجاح",
            user: {
                id: user.id,
                public_id: user.public_id,
                full_name: user.full_name,
                phone: user.phone,
                email: user.email,
                role: user.role,
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
        const commercial_registration_no = String(req.body?.commercial_registration_no || "").trim();
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
            message: "تم تسجيل التاجر وإرسال الطلب للمراجعة",
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
            query = supabase.from("users").select("*").eq("email", loginEmail).limit(1);
        } else {
            query = supabase.from("users").select("*").eq("phone", loginPhone).limit(1);
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

        await supabase
            .from("users")
            .update({
                last_login_at: nowIso(),
                last_seen_at: nowIso(),
            })
            .eq("id", user.id);

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

app.use((req, res) => {
    return res.status(404).json({
        success: false,
        message: "Route not found",
    });
});

app.listen(port, () => {
    console.log(`API running on port ${port}`);
});