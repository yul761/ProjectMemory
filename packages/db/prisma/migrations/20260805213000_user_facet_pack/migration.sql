-- AlterTable
-- Per-tenant profile-facet ontology. NULL means "use the deployment default pack",
-- which is what every existing row gets, so behaviour is unchanged until an
-- operator installs a pack for a specific tenant.
ALTER TABLE "User"
ADD COLUMN "facetPack" JSONB;
