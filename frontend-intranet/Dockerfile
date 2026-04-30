FROM nginx:1.25-alpine
RUN adduser -S nginxuser && \
    chown -R nginxuser /var/cache/nginx /var/log/nginx /etc/nginx/conf.d
COPY src/ /usr/share/nginx/html/
COPY nginx-frontend.conf /etc/nginx/conf.d/default.conf
USER nginxuser
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost/ || exit 1
