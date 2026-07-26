import type { RequestHandler } from "express";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { ApolloServerPluginLandingPageDisabled } from "@apollo/server/plugin/disabled";
import { expressMiddleware } from "@as-integrations/express4";
import { config } from "../config.js";
import { schema } from "./schema.js";
import { root } from "./resolvers.js";
import { createGraphQLContext, type GraphQLContext } from "./context.js";

/**
 * Apollo Server instance backed by the existing graphql-js schema/rootValue
 * pair (#765). The landing page (GraphQL Playground/Sandbox) is only enabled
 * in development so production never serves an interactive query UI.
 */
export const apolloServer = new ApolloServer<GraphQLContext>({
  schema,
  rootValue: root,
  introspection: config.nodeEnv !== "production",
  plugins: [
    config.nodeEnv === "development"
      ? ApolloServerPluginLandingPageLocalDefault()
      : ApolloServerPluginLandingPageDisabled(),
  ],
});

const apolloServerStart = apolloServer.start();
let handler: RequestHandler | null = null;

/**
 * `expressMiddleware()` requires `server.start()` to have already resolved
 * *before* it is called (it asserts synchronously), but `createApp()` builds
 * the Express app synchronously. This lazily builds and caches the real
 * middleware the first time a request comes in, once startup has finished.
 */
export const apolloMiddleware: RequestHandler = async (req, res, next) => {
  if (!handler) {
    await apolloServerStart;
    handler = expressMiddleware(apolloServer, {
      context: async ({ req: expressReq }) => createGraphQLContext({ raw: expressReq }),
    });
  }
  handler(req, res, next);
};
