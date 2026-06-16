# deploy/aeron/Dockerfile
FROM amazoncorretto:11

WORKDIR /opt/aeron

# Bake the pre-compiled Aeron 1.25.1 JAR directly into the image.
# Docker downloads this natively during the build phase. No package managers required.
ADD https://repo1.maven.org/maven2/io/aeron/aeron-all/1.25.1/aeron-all-1.25.1.jar /opt/aeron/aeron-all.jar