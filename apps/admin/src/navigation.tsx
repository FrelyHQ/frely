import {
  Link as RouterLink,
  notFound as createNotFound,
  redirect as createRedirect,
  useLocation,
  useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import * as React from "react";

type AdminLinkProps = Omit<React.ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  replace?: boolean;
  scroll?: boolean;
};

/** Admin-owned navigation adapter. Product UI uses stable href semantics while TanStack owns transitions. */
const RouterAnchor = RouterLink as unknown as React.ForwardRefExoticComponent<
  Omit<AdminLinkProps, "href" | "scroll"> & { resetScroll?: boolean; to: string } & React.RefAttributes<HTMLAnchorElement>
>;

const AdminLink = React.forwardRef<HTMLAnchorElement, AdminLinkProps>(function AdminLink(
  { href, replace, scroll, target, download, ...props },
  ref,
) {
  if (isExternalHref(href) || download !== undefined || (target !== undefined && target.toLowerCase() !== "_self")) {
    return <a ref={ref} href={href} target={target} download={download} {...props} />;
  }
  const routerProps = {
    ref,
    to: href,
    ...(replace === undefined ? {} : { replace }),
    ...(scroll === false ? { resetScroll: false } : {}),
    ...(target === undefined ? {} : { target }),
    ...props,
  };
  return <RouterAnchor {...routerProps} />;
});

export default AdminLink;
export { AdminLink as Link };

export function useRouter() {
  const router = useTanStackRouter();
  return React.useMemo(() => ({
    push: (href: string, options?: { scroll?: boolean }) => navigate(router, href, false, options),
    replace: (href: string, options?: { scroll?: boolean }) => navigate(router, href, true, options),
    refresh: () => router.invalidate(),
    back: () => globalThis.history?.back(),
    forward: () => globalThis.history?.forward(),
  }), [router]);
}

export function usePathname(): string {
  return useLocation({ select: (location) => location.pathname });
}

export function useSearchParams(): URLSearchParams {
  const search = useLocation({ select: (location) => location.searchStr });
  return React.useMemo(() => new URLSearchParams(search), [search]);
}

export function redirect(href: string, statusCode = 307): never {
  throw createRedirect({ href, statusCode });
}

export function notFound(): never {
  throw createNotFound();
}

function navigate(
  router: ReturnType<typeof useTanStackRouter>,
  href: string,
  replace: boolean,
  options?: { scroll?: boolean },
) {
  if (isExternalHref(href)) {
    if (replace) globalThis.location?.replace(href);
    else globalThis.location?.assign(href);
    return Promise.resolve();
  }
  return router.navigate({
    to: href,
    ...(replace ? { replace: true } : {}),
    ...(options?.scroll === false ? { resetScroll: false } : {}),
  });
}

function isExternalHref(href: string): boolean {
  return href.startsWith("//") || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(href);
}
