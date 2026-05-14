/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  return <Navigate to="/login" search={{ redirect: undefined }} />;
}
