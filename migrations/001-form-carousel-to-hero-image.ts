/**
 * Trims multi-slide form carousels to a single hero image.
 *
 * `MAX_CAROUSEL_IMAGES` went from 3 to 1 when product photos moved onto the
 * records a catalogue pages through (`image` field type, record-media.ts). A
 * form written before that can hold three slides, and while `toCarouselView`
 * still renders them, no writer will accept them back — so a tenant editing an
 * old carousel would be told their own data is invalid.
 *
 * Three decisions worth stating:
 *
 *   - **The first slide is the one kept.** It was the hero already: the
 *     carousel is ordered, position *is* slide order, and the first is what a
 *     shared link showed above the fold.
 *   - **Dropped slides are soft-deleted, not hard-deleted, and their bucket
 *     objects are left alone.** This runs as a release job before the app
 *     deploys, with no way to put an object back if the release is rolled
 *     back. `storage_mb` is a lifetime counter that never refunds anyway
 *     (media.ts), so nothing is over-charged by keeping the bytes; a later
 *     sweep can reclaim them once the release has stuck.
 *   - **It is idempotent.** Only documents with more than one slide are
 *     touched, so a re-run after a partial failure resumes rather than
 *     re-trimming what it already did.
 */
import type { Db, ObjectId } from "mongodb";

type CarouselItem = { mediaId: ObjectId; alt: string };

export async function up(db: Db): Promise<void> {
  const forms = db.collection<{ _id: ObjectId; carousel?: CarouselItem[] }>("forms");

  const overfull = await forms.find({ "carousel.1": { $exists: true } }).toArray();
  if (overfull.length === 0) {
    console.log("    no multi-slide carousels to trim");
    return;
  }

  const orphaned: ObjectId[] = [];
  for (const form of overfull) {
    const slides = form.carousel ?? [];
    const [hero, ...dropped] = slides;
    if (!hero) continue;

    await forms.updateOne(
      { _id: form._id },
      { $set: { carousel: [hero], updatedAt: new Date() } },
    );
    orphaned.push(...dropped.map((slide) => slide.mediaId));
  }

  if (orphaned.length > 0) {
    await db
      .collection("media")
      .updateMany(
        { _id: { $in: orphaned }, deletedAt: null },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } },
      );
  }

  console.log(
    `    trimmed ${overfull.length} carousel(s), detached ${orphaned.length} image(s)`,
  );
}
