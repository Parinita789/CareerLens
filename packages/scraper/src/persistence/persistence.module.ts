import { Module } from '@nestjs/common';
import { ScraperPersistenceService } from './persistence.service';

@Module({
  providers: [ScraperPersistenceService],
  exports: [ScraperPersistenceService],
})
export class PersistenceModule {}
