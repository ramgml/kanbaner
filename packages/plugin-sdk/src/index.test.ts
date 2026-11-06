import { describe, expect, it } from "vitest";

import * as sdk from "./index.ts";

describe("@kanbaner/plugin-sdk", () => {
  it("экспортирует версии контрактов", () => {
    expect(sdk.PLUGIN_CONTRACT_VERSION).toBe("1");
    expect(sdk.PLUGIN_CONTRACT_VERSION_NUMBER).toBe(1);
    expect(sdk.UI_CONTRACT_VERSION).toBe("1");
  });

  it("экспортирует схемы и валидаторы всех публичных контрактов", () => {
    expect(sdk.PluginIdSchema).toBeDefined();
    expect(sdk.PluginVersionSchema).toBeDefined();
    expect(sdk.PluginManifestSchema).toBeDefined();
    expect(sdk.CommandMetadataSchema).toBeDefined();
    expect(sdk.QueryMetadataSchema).toBeDefined();
    expect(sdk.OperationMetadataSchema).toBeDefined();
    expect(sdk.OperationEnvelopeSchema).toBeDefined();
    expect(sdk.OperationResultSchema).toBeDefined();
    expect(sdk.EventEnvelopeSchema).toBeDefined();
    expect(sdk.EventSubscriptionSchema).toBeDefined();
    expect(sdk.ResourceRefSchema).toBeDefined();
    expect(sdk.ResourceLinkSchema).toBeDefined();
    expect(sdk.ResourceDescriptorSchema).toBeDefined();
    expect(sdk.UiContributionSchema).toBeDefined();

    expect(sdk.validatePluginManifest).toBeTypeOf("function");
    expect(sdk.validateCommandMetadata).toBeTypeOf("function");
    expect(sdk.validateQueryMetadata).toBeTypeOf("function");
    expect(sdk.validateOperationResult).toBeTypeOf("function");
    expect(sdk.validateEventEnvelope).toBeTypeOf("function");
    expect(sdk.validateResourceRef).toBeTypeOf("function");
    expect(sdk.validateUiContribution).toBeTypeOf("function");
  });
});
