import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { CoordinatorError } from "../domain/errors.js";
import { notOk } from "../domain/apiTypes.js";

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof CoordinatorError) {
      return reply.code(error.statusCode).send(
        notOk(error.code, error.message, error.details),
      );
    }

    // Fastify validation errors
    const err = error as Record<string, unknown>;
    if (err["validation"]) {
      return reply.code(400).send(
        notOk("VALIDATION_ERROR", "Request validation failed", err["validation"]),
      );
    }

    // Fastify 404
    if (err["statusCode"] === 404) {
      return reply.code(404).send(notOk("NOT_FOUND", (error as Error).message));
    }

    request.log.error({ err: error }, "Unhandled error");
    return reply.code(500).send(notOk("INTERNAL_ERROR", "Internal server error"));
  });

  fastify.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(notOk("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });
};

export default fp(errorHandlerPlugin, { name: "error-handler" });
