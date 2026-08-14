import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { getSettings } from '../lib/settings.js';
import { computeAvailability } from '../lib/slots.js';
import {
  createBooking,
  getFormat,
  getService,
  ConflictError,
  ValidationError,
} from '../lib/bookings.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  emailRequestReceived,
  emailPractitionerNewRequest,
} from '../email/notifications.js';

function clientIp(req: FastifyRequest): string {
  const xf = (req.headers['x-forwarded-for'] as string) || '';
  return xf.split(',')[0].trim() || req.ip;
}

export async function publicRoutes(app: FastifyInstance) {
  // --- Services (editable in admin; front end reads them from here) ---------
  app.get('/api/services', async () => {
    const { rows } = await query(
      `SELECT id, name, duration_minutes, price_cents
         FROM services WHERE active = true ORDER BY sort_order, id`,
    );
    return {
      services: rows.map((s: any) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.duration_minutes,
        duration: `${s.duration_minutes} minutes`,
        priceCents: s.price_cents,
        price: `€${(s.price_cents / 100).toFixed(0)}`,
      })),
    };
  });

  app.get('/api/formats', async () => {
    const { rows } = await query(
      `SELECT key, name FROM formats WHERE active = true ORDER BY sort_order`,
    );
    return { formats: rows };
  });

  // --- Availability --------------------------------------------------------
  const availQ = z.object({
    serviceId: z.coerce.number().int().positive(),
    format: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });

  app.get('/api/availability', async (req, reply) => {
    const parsed = availQ.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.issues });
    const { serviceId, format, from, to } = parsed.data;

    const service = await getService(serviceId);
    if (!service || !service.active) return reply.code(404).send({ error: 'unknown_service' });
    const fmt = await getFormat(format);
    if (!fmt || !fmt.active) return reply.code(404).send({ error: 'unknown_format' });

    // Cap the window to a sensible horizon.
    const settings = await getSettings();
    const days = await computeAvailability({
      serviceDurationMinutes: service.duration_minutes,
      format: fmt,
      fromDate: from,
      toDate: to,
      settings,
    });
    return { timezone: 'Europe/Dublin', days };
  });

  // --- Create a booking ----------------------------------------------------
  const createBody = z.object({
    serviceId: z.coerce.number().int().positive(),
    format: z.string().min(1),
    startUtc: z.string().min(10),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().max(40).optional().nullable(),
    referrer: z.string().trim().max(200).optional().nullable(),
    notes: z.string().max(4000).optional().nullable(),
    // Honeypot: must be empty. Bots fill every field.
    website: z.string().optional(),
  });

  app.post('/api/bookings', async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', detail: parsed.error.issues });
    }
    const body = parsed.data;

    // Honeypot — silently accept-looking but drop.
    if (body.website && body.website.trim() !== '') {
      return reply.code(202).send({ ok: true });
    }

    // Rate limits: per IP and per email address.
    const ip = clientIp(req);
    if (!rateLimit(`ip:${ip}`, 8, 60 * 60_000)) {
      return reply.code(429).send({ error: 'rate_limited', scope: 'ip' });
    }
    if (!rateLimit(`email:${body.email.toLowerCase()}`, 5, 24 * 60 * 60_000)) {
      return reply.code(429).send({ error: 'rate_limited', scope: 'email' });
    }

    try {
      const booking = await createBooking({
        serviceId: body.serviceId,
        formatKey: body.format,
        startUtc: body.startUtc,
        patientName: body.name,
        patientEmail: body.email,
        patientPhone: body.phone ?? null,
        referrer: body.referrer ?? null,
        notes: body.notes ?? null,
        source: 'public',
      });

      // Fire the two emails. Failures here must not fail the booking.
      Promise.allSettled([
        emailRequestReceived(booking),
        emailPractitionerNewRequest(booking),
      ]).catch(() => {});

      return reply.code(201).send({
        ok: true,
        status: booking.status,
        booking: {
          id: booking.id,
          service: booking.serviceName,
          format: booking.formatName,
          startUtc: booking.startUtc,
          endUtc: booking.endUtc,
        },
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return reply.code(409).send({
          error: 'slot_taken',
          message: 'That time was just taken. Here are the next available slots.',
          alternatives: err.alternatives,
        });
      }
      if (err instanceof ValidationError) {
        return reply.code(err.status).send({ error: 'invalid', message: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: 'server_error' });
    }
  });
}
