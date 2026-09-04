import {
  Link as RouterLink,
  notFound as createNotFound,
  redirect as createRedirect,
  useLocation,
  useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import * as React from "react";

type WebLinkProps = Omit<React.ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
  replace?: boolean;
  scroll?: boolean;
};

const RouterAnchor = RouterLink as unknown as React.ForwardRefExoticComponent<
  Omit<WebLinkProps, "href" | "scroll"> & { resetScroll?: boolean; to: string } & React.RefAttributes<HTMLAnchorElement>
>;

const WebLink = React.forwardRef<HTMLAnchorElement, WebLinkProps>(function WebLink(
  { href, replace, scroll, target, download, ...props },
  ref,
) {
  if (isExternalHref(href) || download !== undefined || (target !== undefined && target.toLowerCase() !== "_self")) {
    return <a ref={ref} href={href} target={target} download={download} {...props} />;
  }
  return <RouterAnchor
    ref={ref}
    to={href}
    {...(replace === undefined ? {} : { replace })}
    {...(scroll === false ? { resetScroll: false } : {})}
    {...(target === undefined ? {} : { target })}
    {...props}
  />;
});

export default WebLink;
export { WebLink as Link };

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
