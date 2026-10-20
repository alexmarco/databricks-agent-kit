import { test } from "node:test";
import assert from "node:assert/strict";
import { selectIntegrationConnection } from "./integration/connection.ts";

const host = "https://dbc-test.cloud.databricks.com";
const completeEnv = {
  DATABRICKS_HOST: host,
  DATABRICKS_CLIENT_ID: "client-id-value",
  DATABRICKS_CLIENT_SECRET: "client-secret-value",
};

test("complete environment credentials are used over the named profile", () => {
  const request = selectIntegrationConnection({ ...completeEnv, DAK_IT_PROFILE: "dev" });
  assert.deepEqual(request, {
    profile: "",
    explicitProfile: false,
    env: completeEnv,
  });
});

test("missing connection settings fail with the names of the missing variables and never their values", () => {
  const env = { DATABRICKS_HOST: host, DATABRICKS_CLIENT_ID: "client-id-value", DATABRICKS_CLIENT_SECRET: "" };
  assert.throws(
    () => selectIntegrationConnection(env),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /DATABRICKS_CLIENT_SECRET/);
      assert.match(message, /DAK_IT_PROFILE/);
      assert.doesNotMatch(message, /https?:\/\//, "the message holds no host URL");
      assert.ok(!message.includes("client-id-value"), "the message holds no values");
      return true;
    },
  );
});

test("the named profile is used when the environment credentials are not all set", () => {
  const request = selectIntegrationConnection({
    DATABRICKS_HOST: host,
    DATABRICKS_CLIENT_ID: "",
    DAK_IT_PROFILE: "dev",
  });
  assert.deepEqual(request, {
    profile: "dev",
    explicitProfile: true,
    env: { DATABRICKS_HOST: host, DATABRICKS_CLIENT_ID: "", DAK_IT_PROFILE: "dev" },
  });
});
