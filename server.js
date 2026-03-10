import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import { createClient } from "@supabase/supabase-js"

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PORT = process.env.PORT || 3000

async function generateOrderNumber() {

    const year = new Date().getFullYear()

    const { data } = await supabase
        .from("orders")
        .select("order_no")
        .order("created_at", { ascending: false })
        .limit(1)

    let seq = 1

    if (data && data.length) {

        const last = data[0].order_no.split("-")[2]

        seq = parseInt(last) + 1

    }

    return `PP-${year}-${String(seq).padStart(8, "0")}`

}

app.get("/", (req, res) => {
    res.json({ status: "PParts API running" })
})

app.post("/orders", async (req, res) => {

    try {

        const { telegram_id, car_name, car_model, vin, notes } = req.body

        let { data: user } = await supabase
            .from("users")
            .select("*")
            .eq("telegram_id", telegram_id)
            .single()

        if (!user) {

            const insert = await supabase
                .from("users")
                .insert({ telegram_id })
                .select()
                .single()

            user = insert.data

        }

        const orderNo = await generateOrderNumber()

        const { data, error } = await supabase
            .from("orders")
            .insert({
                order_no: orderNo,
                user_id: user.id,
                car_name,
                car_model,
                vin,
                notes
            })
            .select()
            .single()

        if (error) throw error

        res.json({
            success: true,
            order: data
        })

    } catch (e) {

        console.error(e)

        res.status(500).json({
            success: false
        })

    }

})

app.get("/orders/:orderNo", async (req, res) => {

    try {

        const { data, error } = await supabase
            .from("orders")
            .select(`
*,
order_items(*)
`)
            .eq("order_no", req.params.orderNo)
            .single()

        if (error) throw error

        res.json(data)

    } catch (e) {

        res.status(404).json({
            error: "not found"
        })

    }

})

app.post("/orders/:orderId/items", async (req, res) => {

    try {

        const { name, part_no, photo_url } = req.body

        const { data, error } = await supabase
            .from("order_items")
            .insert({
                order_id: req.params.orderId,
                name,
                part_no,
                photo_url
            })
            .select()
            .single()

        if (error) throw error

        res.json(data)

    } catch (e) {

        res.status(500).json({
            error: "failed"
        })

    }

})

app.listen(PORT, () => {
    console.log("API running on port " + PORT)
})