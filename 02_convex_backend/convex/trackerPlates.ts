import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const assignLicensePlate = mutation({
  args: {
    trackerName: v.string(),
    licensePlate: v.string(),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const existing = await ctx.db
      .query("tracker_plate_assignments")
      .withIndex("by_tracker_name", (q) => q.eq("trackerName", args.trackerName))
      .collect();

    if (existing.length === 0) {
      const id = await ctx.db.insert("tracker_plate_assignments", {
        trackerName: args.trackerName,
        licensePlate: args.licensePlate,
        updatedAtMs: nowMs,
      });

      return {
        ok: true,
        created: true,
        id,
      };
    }

    const [current, ...duplicates] = existing;
    await ctx.db.patch(current._id, {
      licensePlate: args.licensePlate,
      updatedAtMs: nowMs,
    });

    for (const duplicate of duplicates) {
      await ctx.db.delete(duplicate._id);
    }

    return {
      ok: true,
      created: false,
      id: current._id,
    };
  },
});

export const getByTrackerName = query({
  args: {
    trackerName: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tracker_plate_assignments")
      .withIndex("by_tracker_name", (q) => q.eq("trackerName", args.trackerName))
      .first();
  },
});

export const getByLicensePlate = query({
  args: {
    licensePlate: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tracker_plate_assignments")
      .withIndex("by_license_plate", (q) => q.eq("licensePlate", args.licensePlate))
      .collect();
  },
});

