package ffservice;

import ffservice.handler.Api;
import ffservice.repository.Repository;
import ffservice.repository.SqliteRepository;
import ffservice.service.FlagService;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.Ordered;

/**
 * Entry point: {@code java -jar target/ffservice.jar} reads PORT, DB_PATH, ADMIN_KEY and CLIENT_KEY from the
 * environment. A missing key stops the process at start-up instead of at the first request.
 */
@SpringBootApplication
public class Application {
  public static void main(String[] args) {
    start(Config.load(System.getenv()), args);
  }

  /** Start the service with an explicit configuration (tests use port 0 and ":memory:"). */
  public static ConfigurableApplicationContext start(Config config, String... args) {
    SpringApplication app = new SpringApplication(Application.class);
    app.setDefaultProperties(Map.of("server.port", config.port()));
    app.addInitializers(context -> context.getBeanFactory().registerSingleton("config", config));
    return app.run(args);
  }

  @Bean(destroyMethod = "close")
  Repository repository(Config config) {
    return new SqliteRepository(config.dbPath());
  }

  @Bean
  FlagService flagService(Repository repository) {
    return new FlagService(repository);
  }

  /** The whole HTTP layer: a filter first in the chain that answers every request (see {@link Api}). */
  @Bean
  FilterRegistrationBean<Api> api(FlagService service, Config config) {
    FilterRegistrationBean<Api> bean = new FilterRegistrationBean<>(new Api(service, config));
    bean.addUrlPatterns("/*");
    bean.setOrder(Ordered.HIGHEST_PRECEDENCE);
    return bean;
  }
}
