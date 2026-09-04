import registryManifest from "./catalog.generated.json" with { type: "json" };
import ownerMetadataManifest from "./owner-operation-metadata.generated.json" with { type: "json" };
import {
  ApplicationOperationRegistry,
  createApplicationOperationExclusions,
  OwnerOperationMetadataRegistry,
} from "./registry.js";

if (registryManifest.schema !== "application-operation-registry.v1" || registryManifest.checkpoint !== "MODERNIZATION-08") {
  throw new TypeError("invalid application operation registry manifest");
}
if (ownerMetadataManifest.schema !== "owner-operation-metadata.v1" || ownerMetadataManifest.checkpoint !== "MODERNIZATION-08") {
  throw new TypeError("invalid Owner operation metadata manifest");
}
if (registryManifest.inventorySha256 !== ownerMetadataManifest.inventorySha256) {
  throw new TypeError("application and Owner operation manifests use different inventories");
}

export const applicationOperationRegistry = new ApplicationOperationRegistry(registryManifest.operations);
export const applicationOperationExclusions = createApplicationOperationExclusions(registryManifest.exclusions);
export const ownerOperationMetadata = new OwnerOperationMetadataRegistry(
  ownerMetadataManifest.operations,
  applicationOperationRegistry,
);
export const applicationOperationInventorySha256 = registryManifest.inventorySha256;
export const applicationOperationClassificationCounts = Object.freeze({ ...registryManifest.classificationCounts });
