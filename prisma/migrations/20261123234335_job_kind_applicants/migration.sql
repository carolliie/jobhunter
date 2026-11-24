-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "applicants" INTEGER,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'job';
