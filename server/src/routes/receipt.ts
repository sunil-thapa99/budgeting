import { Router } from 'express';
import { nvidia, VISION_MODEL, assertKey } from '../nvidia.js';

const router = Router();

// POST /api/receipt  { image: "data:image/jpeg;base64,..." }  (client downsizes first)
// -> { merchant, date, total, category, currency, raw }
router.post('/', async (req, res, next) => {
  try {
    assertKey();
    const image: string = req.body?.image;
    if (!image || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Send { image: dataURI } (jpeg/png).' });
    }

    const prompt = `You are reading a photo of a purchase receipt.
Extract these fields and reply with ONLY a JSON object, no prose:
{"merchant": string, "date": "YYYY-MM-DD" or null, "total": number, "currency": string, "category": string}
- "total" is the final grand total actually paid (after tax), as a number with no currency symbol.
- "category" is your best guess from: Groceries, Dining, Coffee, Transportation, Shopping, Rent, Internet, Insurance, Miscellaneous.
If a field is unreadable use null (but always try hard for total).`;

    const completion = await nvidia.chat.completions.create({
      model: VISION_MODEL,
      temperature: 0.1,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image } },
        ] as any,
      }],
    });

    const text = completion.choices[0]?.message?.content ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    let parsed: any = {};
    if (match) { try { parsed = JSON.parse(match[0]); } catch { /* keep raw */ } }
    res.json({
      merchant: parsed.merchant ?? null,
      date: parsed.date ?? null,
      total: typeof parsed.total === 'number' ? parsed.total : Number(parsed.total) || null,
      currency: parsed.currency ?? 'USD',
      category: parsed.category ?? 'Miscellaneous',
      raw: text,
      model: VISION_MODEL,
    });
  } catch (err) { next(err); }
});

export default router;
